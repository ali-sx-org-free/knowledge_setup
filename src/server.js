// 服務入口：組裝 Git 持久化、知識庫、API 與管理後台，並啟動保鮮排程。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Settings } from './config.js';
import { GitRepo } from './git/repo.js';
import { SshKeys } from './git/ssh.js';
import { KnowledgeStore } from './store/store.js';
import { RuleError } from './store/validity.js';
import { ActionRunner } from './services/actions.js';
import { ExecutionService } from './services/executions.js';
import { AskService } from './services/ask.js';
import { LlmClient } from './services/llm.js';
import { Auth, HttpError } from './api/auth.js';
import { v1Router } from './api/v1.js';
import { adminRouter } from './api/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, '..', 'web');
const SYSTEM = Object.freeze({ id: 'system', name: '保鮮觸發器', kind: 'system', role: 'owner', isAdmin: false });

export async function createServer({ dataDir = process.env.DATA_DIR || path.join(here, '..', 'data'), env = process.env, fetchImpl = globalThis.fetch, logger = console, schedulers = true, executions = {} } = {}) {
  const settings = new Settings(dataDir, env);
  const ctx = { settings, env, logger, dataDir, fetch: fetchImpl };
  ctx.llm = new LlmClient({ settings, fetchImpl });
  ctx.auth = new Auth(ctx);
  // SSH 部署金鑰（ssh 倉庫地址時使用）：DATA_DIR/ssh/，或由 KNOWLEDGE_GIT_SSH_KEY_FILE 指定私鑰檔
  ctx.ssh = new SshKeys({ dir: path.join(dataDir, 'ssh'), keyFile: env.KNOWLEDGE_GIT_SSH_KEY_FILE });

  /** 依 Git 設定（重新）建立知識庫；切換倉庫時調用。 */
  ctx.reconfigure = async () => {
    const g = settings.section('git');
    const slug = crypto.createHash('sha1').update(`${g.url || 'local'}#${g.branch}`).digest('hex').slice(0, 12);
    const dir = env.KNOWLEDGE_REPO_DIR || path.join(dataDir, 'repos', slug);
    const repo = new GitRepo({ dir, url: g.url, branch: g.branch, token: g.token, username: g.username, ssh: ctx.ssh, authorName: g.authorName, authorEmail: g.authorEmail });
    const store = new KnowledgeStore({ repo, subdir: g.subdir, autoPush: g.autoPush !== false, logger });
    await store.init();
    if (ctx.store) await ctx.store.flushLazy().catch(() => {});
    ctx.store = store;
    // RPA 校驗的執行記錄按倉庫分目錄（本地營運數據，不進 Git）
    if (ctx.executions) await ctx.executions.stop();
    ctx.executions = await new ExecutionService({ store, dir: path.join(dataDir, 'executions', slug), env, fetchImpl, logger, ...executions }).init();
    ctx.actions = new ActionRunner({ store, env, fetchImpl, executions: ctx.executions });
    ctx.ask = new AskService({ store, actions: ctx.actions, llm: ctx.llm, logger });
    return store;
  };

  ctx.runExpirySweep = async () => {
    const out = await ctx.store.tx(SYSTEM, r => `[保鮮] ${r.length} 條 L0 知識到期，降為 L1 並排入重驗`, t => ctx.store.expirySweep(t));
    return { expired: out.result, commit: out.commit };
  };

  await ctx.reconfigure();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(ctx.auth.middleware());
  app.use('/api/v1', v1Router(ctx));
  app.use('/admin/api', adminRouter(ctx));
  app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: '5m' }));
  app.get('/', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

  // 錯誤碼：優先用錯誤自帶的 code；沒有時 4xx 按狀態碼給出（不再把客戶端錯誤標成 internal_error），5xx 才是 internal_error。
  const STATUS_CODES = { 400: 'invalid_input', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'payload_too_large', 415: 'unsupported_media_type', 422: 'rule_violation', 429: 'too_many_requests' };
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let code = typeof err.code === 'string' ? err.code : status < 500 ? STATUS_CODES[status] || 'error' : 'internal_error';
    let message = err.message;
    if (err.type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; message = `請求體不是合法的 JSON：${err.message}`; }
    if (err.type === 'entity.too.large') message = '請求體過大（上限 4 MB）';
    if (!(err instanceof RuleError) && !(err instanceof HttpError) && status >= 500) logger.error?.(`[knowledge] ${req.method} ${req.originalUrl}`, err);
    const body = { error: { code, message: status >= 500 && !(err instanceof RuleError) && !(err instanceof HttpError) && !err.code ? '服務內部錯誤' : message } };
    if (err.index !== undefined) body.error.index = err.index;
    if (err.missing) body.error.missing = err.missing;
    if (err.problems) body.error.problems = err.problems;
    res.status(status).json(body);
  });

  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => fn().catch(err => logger.warn?.(`[knowledge] 排程任務失敗：${err.message}`)), ms));
  if (schedulers) {
    every(30000, () => ctx.store.flushLazy());
    every(Math.max(15, Number(settings.value('git.pullIntervalSec')) || 60) * 1000, async () => { if (ctx.store.repo.url) await ctx.store.sync(); });
    every(3600 * 1000, ctx.runExpirySweep);
    let lastValidation = Date.now();
    every(10 * 60 * 1000, async () => {
      const hours = Number(ctx.store.config.validationIntervalHours) || 0;
      if (!hours || Date.now() - lastValidation < hours * 3600 * 1000) return;
      lastValidation = Date.now();
      await ctx.actions.validateAll(SYSTEM, {});
    });
    ctx.runExpirySweep().catch(err => logger.warn?.(`[knowledge] 到期檢查失敗：${err.message}`));
  }

  let server;
  return {
    app,
    ctx,
    listen(port = Number(env.PORT) || 8080, host = env.HOST || '0.0.0.0') {
      return new Promise(resolve => { server = app.listen(port, host, () => resolve(server)); });
    },
    async close() {
      timers.forEach(clearInterval);
      await ctx.executions?.stop();
      await ctx.store.flushLazy().catch(() => {});
      await ctx.store.flushPush().catch(() => {});
      if (server) await new Promise(r => server.close(r));
    }
  };
}

// 直接執行本檔時啟動服務。ESM 的 import.meta.url 是解析符號連結後的真實路徑，argv[1] 不是：
// 經符號連結的目錄啟動（如 macOS 的 /var → /private/var）時要先取真實路徑再比較，否則程序會靜默退出。
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const srv = await createServer();
  const port = Number(process.env.PORT) || 8080;
  await srv.listen(port);
  const g = srv.ctx.store.repo.status;
  console.log(`[knowledge] 服務已啟動：http://localhost:${port}`);
  console.log(`[knowledge] 知識倉庫：${g.remote || '本地倉庫（未配置遠端）'} · 分支 ${g.branch} · 認證 ${srv.ctx.store.repo.authMode()} · 目錄 ${srv.ctx.store.repo.dir}`);
  console.log(`[knowledge] 智能體教程：http://localhost:${port}/api/v1/prompt`);
  if (srv.ctx.settings.generatedAdminPassword) console.log(`[knowledge] 初始管理員密碼：${srv.ctx.settings.generatedAdminPassword}`);
  const shutdown = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
