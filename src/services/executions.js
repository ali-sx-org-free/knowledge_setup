// RPA 校驗的異步執行：受理 → 提交運行 → 輪詢 → 判定 → 寫回有效性。
// 執行記錄是本地營運數據，存 DATA_DIR/executions/<倉庫>/EX-….json（先寫臨時檔再改名），不進 Git；
// 只有判定為 pass 的結果經 store.tx 寫回知識（一次 Git 提交）。設計見 docs/design/rpa-integration.md §6.3、§8。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RuleError } from '../store/validity.js';
import { parseLocator, renderSceneInputs, evaluateExpect, evidenceOf, actionHash } from '../store/rpa.js';
import { RpaClient, RpaError } from './rpa.js';

export const EXECUTION_STATES = {
  accepted: { name: '已受理', terminal: false },
  submitted: { name: '排隊中', terminal: false },
  running: { name: '執行中', terminal: false },
  needs_login: { name: '需要登入', terminal: true },
  rejected: { name: '已拒絕', terminal: true },
  expired: { name: '已逾時', terminal: true },
  done: { name: '已完成', terminal: true }
};

export const EXECUTION_REASONS = {
  revision_changed: '場景版本與審閱版本不同，需負責人重新審閱',
  scene_archived: '場景已歸檔',
  not_published: '場景沒有發布的版本',
  inputs_invalid: '入參不符合場景宣告',
  action_changed: 'Action 在執行前被修改或停用',
  pipeline_missing: '管道不存在或已不是 RPA 管道',
  queue_timeout: '一直排隊，沒有可用的 Worker',
  deadline: '超過整體期限，結果未知',
  run_not_found: 'RPA 找不到這個運行',
  needs_login: '登入角色需要人工登入',
  expect_failed: '守衛不符：出參與客體定位對不上',
  rpa_failed: 'RPA 運行失敗',
  rpa_timed_out: 'RPA 運行逾時',
  rpa_cancelled: 'RPA 運行已取消',
  internal_error: '知識庫內部錯誤'
};

const terminal = state => EXECUTION_STATES[state]?.terminal === true;
const nowIso = ms => new Date(ms).toISOString();
const DAY = 24 * 3600 * 1000;

function newId(ms) {
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `EX-${day}-${crypto.randomBytes(3).toString('hex')}`;
}

export class ExecutionService {
  constructor({ store, dir, env = process.env, fetchImpl = globalThis.fetch, logger = console, tickMs = 1000, minPollMs = 500, backoffMs = 2000, retentionDays = 180, maxRecords = 5000, now = () => Date.now() }) {
    Object.assign(this, { store, dir, env, fetchImpl, logger, tickMs, minPollMs, backoffMs, retentionDays, maxRecords, now });
    this.records = new Map();
    this.busy = new Set();
    this.writes = new Map();
    this.contracts = new Map();
    this.legacy = new Set(); // 不認識 expectedRevision 的舊版 RPA（按管道記住）
    this.timer = null;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = (await fs.readdir(this.dir)).filter(f => /^EX-[\w-]+\.json$/.test(f)).sort();
    for (const f of files) {
      try {
        const exec = JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8'));
        if (!exec?.id) continue;
        // 重啟恢復：未到終態的執行馬上繼續（accepted 用原冪等鍵重新提交，RPA 保證不重複派發）
        if (!terminal(exec.state)) exec.nextAt = this.now();
        this.records.set(exec.id, exec);
      } catch (err) {
        this.logger.warn?.(`[knowledge] 執行記錄 ${f} 無法讀取：${err.message}`);
      }
    }
    await this.prune();
    this.prunedAt = this.now();
    if (this.tickMs > 0) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.timer.unref?.();
    }
    return this;
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.writes.values()]);
  }

  /** 保留期：終態記錄超過保留天數刪除；超過上限刪最舊的。 */
  async prune() {
    const cutoff = this.now() - this.retentionDays * DAY;
    const done = [...this.records.values()].filter(e => terminal(e.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const drop = done.filter(e => Date.parse(e.createdAt) < cutoff);
    const rest = done.length - drop.length;
    if (rest > this.maxRecords) drop.push(...done.filter(e => !drop.includes(e)).slice(0, rest - this.maxRecords));
    for (const e of drop) {
      this.records.delete(e.id);
      await fs.rm(path.join(this.dir, `${e.id}.json`), { force: true }).catch(() => {});
    }
    return drop.length;
  }

  save(exec) {
    exec.updatedAt = nowIso(this.now());
    const file = path.join(this.dir, `${exec.id}.json`);
    const text = JSON.stringify(exec, null, 2);
    const prev = this.writes.get(exec.id) || Promise.resolve();
    const next = prev.then(async () => {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, file);
    }).catch(err => this.logger.warn?.(`[knowledge] 執行記錄 ${exec.id} 寫入失敗：${err.message}`));
    this.writes.set(exec.id, next);
    next.finally(() => { if (this.writes.get(exec.id) === next) this.writes.delete(exec.id); });
    return next;
  }

  get(id) {
    const exec = this.records.get(id);
    if (!exec) throw new RuleError(`找不到執行 ${id}`, 404, 'not_found');
    return exec;
  }

  list({ itemId, actionId, state, runId, pipelineId, limit = 50 } = {}) {
    const states = state ? String(state).split(',') : null;
    return [...this.records.values()]
      .filter(e => (!itemId || e.target.itemId === itemId) && (!actionId || e.actionId === actionId) && (!pipelineId || e.pipelineId === pipelineId) && (!states || states.includes(e.state)) && (!runId || e.rpa?.runId === runId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.min(500, Math.max(1, Number(limit) || 50)));
  }

  activeFor(itemId, actionId) {
    for (const e of this.records.values()) if (!terminal(e.state) && e.target.itemId === itemId && e.actionId === actionId && !e.dryRun) return e;
    return null;
  }

  client(pipeline) {
    return new RpaClient(pipeline, { env: this.env, fetchImpl: this.fetchImpl });
  }

  /** 讀審閱版本的場景契約（版本不可變，按 管道/場景/版本 快取）。 */
  async contractFor(pipeline, action) {
    const key = `${pipeline.id}|${pipeline.baseUrl}|${action.rpa.sceneId}|${action.rpa.revision}`;
    if (this.contracts.has(key)) return this.contracts.get(key);
    const out = await this.client(pipeline).contract(action.rpa.sceneId, action.rpa.revision);
    const value = { contentHash: out.revision.contentHash || null, contract: out.contract };
    this.contracts.set(key, value);
    return value;
  }

  cachedContract(pipeline, action) {
    return this.contracts.get(`${pipeline.id}|${pipeline.baseUrl}|${action.rpa.sceneId}|${action.rpa.revision}`)?.contract || null;
  }

  /**
   * 受理一次校驗（同步檢查都已在調用者完成：權限、掛載、客體種類、適用性）。
   * 定位解析失敗 400 locator_invalid；入參渲染出問題 400 inputs_invalid。同一個（條目, Action）
   * 已有未結束的執行時返回那個執行（deduped: true）。dryRun 是「試運行」：走完整流程，但不寫回。
   */
  start({ ref, action, object, principal, dryRun = false }) {
    const pipeline = this.store.pipelines.get(action.pipelineId);
    if (pipeline?.type !== 'rpa') throw new RuleError(`Action ${action.id} 的管道不是 RPA 管道`, 422, 'pipeline_missing');
    const itemId = ref?.item?.id || null;
    if (!dryRun) {
      const active = this.activeFor(itemId, action.id);
      if (active) return { execution: active, deduped: true };
    }
    const groups = parseLocator(action, object?.locator);
    const { inputs, problems } = renderSceneInputs(action, { object, groups }, this.cachedContract(pipeline, action));
    if (problems.length) throw Object.assign(new RuleError(`入參不符合場景宣告：${problems.map(p => `${p.name} ${p.message}`).join('；')}`, 400, 'inputs_invalid'), { problems });
    const now = this.now();
    const id = newId(now);
    const rp = pipeline.rpa || {};
    const exec = {
      id,
      kind: 'validate',
      dryRun: !!dryRun,
      actionId: action.id,
      actionName: action.name,
      actionHash: actionHash(action),
      pipelineId: pipeline.id,
      target: { itemId, itemKind: ref?.kind || null, subjectId: ref?.subject?.id || null, objectId: object?.id || null, objectName: object?.name || null, locator: object?.locator || null },
      requestedBy: { kind: principal?.kind || 'system', id: principal?.id || 'system', name: principal?.name || null },
      groups,
      inputs,
      spec: { rpa: action.rpa, check: action.check, evidence: action.evidence },
      rpa: { sceneId: action.rpa.sceneId, expectedRevision: action.rpa.revision, contentHash: action.rpa.contentHash, idempotencyKey: `kb:${id}`, runId: null, revision: null, scenarioHash: null, status: null, stage: null, workerId: null, error: null, role: null, portalUrl: null, finishedAt: null },
      state: 'accepted',
      verdict: null,
      reason: null,
      detail: null,
      problems: null,
      failures: null,
      evidence: null,
      effect: null,
      commit: null,
      attempts: 0,
      lastError: null,
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      submittedAt: null,
      finishedAt: null,
      deadlineAt: nowIso(now + (rp.deadlineSec || 900) * 1000),
      nextAt: now,
      pollMs: Math.max(this.minPollMs, rp.pollIntervalMs || 3000)
    };
    this.records.set(id, exec);
    this.save(exec);
    queueMicrotask(() => this.tick());
    return { execution: exec, deduped: false };
  }

  /** expired 的執行：再讀一次原運行（已結束就照常判定和寫回，仍受寫回前的過期檢查約束）。 */
  refresh(id) {
    const exec = this.get(id);
    if (exec.state !== 'expired' || !exec.rpa?.runId) throw new RuleError('只有已逾時且有運行 ID 的執行可以重新讀取原運行', 409, 'not_refreshable');
    const pipeline = this.store.pipelines.get(exec.pipelineId);
    const now = this.now();
    exec.state = exec.rpa.status === 'running' ? 'running' : 'submitted';
    exec.reason = null;
    exec.detail = null;
    exec.finishedAt = null;
    exec.deadlineAt = nowIso(now + (pipeline?.rpa?.deadlineSec || 900) * 1000);
    exec.refreshedAt = nowIso(now);
    exec.nextAt = now;
    this.save(exec);
    queueMicrotask(() => this.tick());
    return exec;
  }

  inFlight(pipelineId) {
    let n = 0;
    for (const e of this.records.values()) if (e.pipelineId === pipelineId && (e.state === 'submitted' || e.state === 'running' || (e.state === 'accepted' && this.busy.has(e.id)))) n++;
    return n;
  }

  /** 排程一輪：到時間的執行提交或輪詢；每條管道在途的運行不超過 maxConcurrent。 */
  tick() {
    const now = this.now();
    if (!this.prunedAt || now - this.prunedAt > 3600 * 1000) {
      this.prunedAt = now;
      this.prune().catch(err => this.logger.warn?.(`[knowledge] 執行記錄清理失敗：${err.message}`));
    }
    for (const exec of this.records.values()) {
      if (terminal(exec.state) || this.busy.has(exec.id) || (exec.nextAt || 0) > now) continue;
      if (exec.state === 'accepted') {
        const max = this.store.pipelines.get(exec.pipelineId)?.rpa?.maxConcurrent || 2;
        if (this.inFlight(exec.pipelineId) >= max) continue;
      }
      this.busy.add(exec.id);
      const work = exec.state === 'accepted' ? this.submit(exec) : this.poll(exec);
      work
        .catch(err => this.crashed(exec, err))
        .finally(() => {
          this.busy.delete(exec.id);
          this.save(exec);
        });
    }
  }

  /** 等全部到期的工作做完（測試與關閉時用）。 */
  async settle(maxMs = 5000) {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      this.tick();
      if (!this.busy.size) return;
      await new Promise(r => setTimeout(r, 5));
    }
  }

  crashed(exec, err) {
    this.logger.warn?.(`[knowledge] 執行 ${exec.id} 出錯：${err.stack || err.message}`);
    exec.lastError = err.message;
    if (exec.state === 'accepted') return this.finish(exec, 'rejected', { reason: 'internal_error', detail: err.message });
    this.later(exec, true);
  }

  later(exec, backoff = false) {
    const now = this.now();
    if (backoff) exec.nextAt = now + Math.min(60000, this.backoffMs * 2 ** Math.min(6, Math.max(0, exec.attempts - 1)));
    else {
      exec.nextAt = now + exec.pollMs;
      const max = this.store.pipelines.get(exec.pipelineId)?.rpa?.maxPollIntervalMs || 15000;
      exec.pollMs = Math.max(this.minPollMs, Math.min(max, Math.round(exec.pollMs * 1.5)));
    }
  }

  finish(exec, state, { verdict = null, reason = null, detail = null, ...rest } = {}) {
    exec.state = state;
    exec.verdict = verdict;
    exec.reason = reason;
    exec.detail = detail || (reason ? EXECUTION_REASONS[reason] || reason : null);
    Object.assign(exec, rest);
    exec.finishedAt = nowIso(this.now());
    exec.nextAt = null;
  }

  pastDeadline(exec) {
    return exec.deadlineAt && this.now() > Date.parse(exec.deadlineAt);
  }

  /** 執行時仍要用同一個配置：Action 沒改、沒停用，管道還在。 */
  resolve(exec) {
    const action = this.store.actions.get(exec.actionId);
    const pipeline = this.store.pipelines.get(exec.pipelineId);
    if (!pipeline || pipeline.type !== 'rpa' || action?.pipelineId !== pipeline.id) {
      this.finish(exec, 'rejected', { reason: 'pipeline_missing' });
      return null;
    }
    if (!action || action.enabled === false || actionHash(action) !== exec.actionHash) {
      this.finish(exec, 'rejected', { reason: 'action_changed' });
      return null;
    }
    return { action, pipeline, client: this.client(pipeline) };
  }

  /** RPA 錯誤：可重試的退避（同一個冪等鍵），其餘記為 rejected（帶 RPA 的錯誤碼）。 */
  onSubmitError(exec, err) {
    if (!(err instanceof RpaError)) throw err;
    exec.lastError = err.message;
    if (err.retryable) {
      if (this.pastDeadline(exec)) return this.finish(exec, 'expired', { reason: 'deadline', detail: `RPA 一直不可用：${err.message}` });
      return this.later(exec, true);
    }
    if (err.code === 'revision_mismatch') return this.finish(exec, 'rejected', { reason: 'revision_changed', detail: `RPA 這次會用 v${err.details.revision ?? '?'}，Action 審閱的是 v${exec.rpa.expectedRevision}；請負責人審閱新版本` });
    if (err.code === 'login_required' || err.code === 'needs_login') return this.finish(exec, 'needs_login', { reason: 'needs_login', detail: err.message });
    const problems = Array.isArray(err.details?.problems) ? err.details.problems : null;
    this.finish(exec, 'rejected', { reason: err.code, detail: err.message, problems });
  }

  async submit(exec) {
    const ctx = this.resolve(exec);
    if (!ctx) return;
    const { action, pipeline, client } = ctx;
    exec.attempts += 1;
    const rp = pipeline.rpa || {};
    try {
      // 1. 版本預檢：發布版本必須是審閱版本
      const scene = await client.scene(action.rpa.sceneId);
      if (scene.archived) return this.finish(exec, 'rejected', { reason: 'scene_archived' });
      if (!scene.publishedRevision) return this.finish(exec, 'rejected', { reason: 'not_published' });
      if (Number(scene.publishedRevision) !== action.rpa.revision) return this.finish(exec, 'rejected', { reason: 'revision_changed', detail: `場景已發布 v${scene.publishedRevision}，Action 審閱的是 v${action.rpa.revision}；請負責人審閱新版本` });
      const { contentHash, contract } = await this.contractFor(pipeline, action);
      if (contentHash && contentHash !== action.rpa.contentHash) return this.finish(exec, 'rejected', { reason: 'revision_changed', detail: `v${action.rpa.revision} 的內容雜湊與審閱時不同（${contentHash.slice(0, 12)} ≠ ${String(action.rpa.contentHash).slice(0, 12)}）` });
      // 按場景入參宣告轉型與檢查
      const rendered = renderSceneInputs(action, { object: { id: exec.target.objectId, name: exec.target.objectName, locator: exec.target.locator }, groups: exec.groups }, contract);
      if (rendered.problems.length) return this.finish(exec, 'rejected', { reason: 'inputs_invalid', detail: rendered.problems.map(p => `${p.name} ${p.message}`).join('；'), problems: rendered.problems });
      exec.inputs = rendered.inputs;
      // 2. 角色預檢：需要登入時不消耗運行（unknown 照常派發；讀不到角色時交給 RPA 判斷）
      if (contract.loginRole) {
        const roles = await client.roles().catch(() => null);
        const list = Array.isArray(roles) ? roles : roles?.roles;
        const role = Array.isArray(list) ? list.find(r => r.id === contract.loginRole) : null;
        exec.rpa.role = contract.loginRole;
        if (role && (role.status === 'needs_login' || role.status === 'none')) return this.finish(exec, 'needs_login', { reason: 'needs_login', detail: `登入角色 ${contract.loginRole} 需要人工登入；請在 RPA 登入後重試` });
      }
      // 3. 提交（同一個冪等鍵重試只會有一個運行）
      const body = { inputs: exec.inputs, idempotencyKey: exec.rpa.idempotencyKey };
      if (rp.target) body.target = rp.target;
      if (rp.workerId) body.workerId = rp.workerId;
      const sceneId = action.rpa.sceneId;
      let run;
      if (this.legacy.has(pipeline.id)) run = await client.createRun(sceneId, body);
      else {
        try {
          run = await client.createRun(sceneId, { ...body, expectedRevision: action.rpa.revision });
        } catch (err) {
          const legacy = err instanceof RpaError && err.status === 422 && err.code === 'request_invalid' && JSON.stringify(err.details || {}).includes('expectedRevision');
          if (!legacy) throw err;
          this.legacy.add(pipeline.id);
          this.logger.warn?.(`[knowledge] 管道 ${pipeline.id} 的 RPA 不支持 expectedRevision，改用 202 後比對版本`);
          run = await client.createRun(sceneId, body);
        }
      }
      // 4. 確認版本（舊版 RPA 沒有原子比對時的兜底）
      this.absorbRun(exec, run, client);
      exec.submittedAt = nowIso(this.now());
      if (Number(run.revision) !== action.rpa.revision) {
        await client.cancelRun(run.id).catch(() => {});
        return this.finish(exec, 'rejected', { reason: 'revision_changed', detail: `RPA 用了 v${run.revision}，Action 審閱的是 v${action.rpa.revision}；運行已取消` });
      }
      const deadlineSec = rp.deadlineSec || (contract.deadlineMs ? Math.ceil(contract.deadlineMs / 1000) + (rp.queueTimeoutSec || 300) + 60 : 900);
      exec.deadlineAt = nowIso(this.now() + deadlineSec * 1000);
      if (run.finished || !['queued', 'running'].includes(run.status)) return this.judge(exec, run);
      exec.state = run.status === 'running' ? 'running' : 'submitted';
      this.later(exec);
    } catch (err) {
      this.onSubmitError(exec, err);
    }
  }

  absorbRun(exec, run, client) {
    Object.assign(exec.rpa, {
      runId: run.id || exec.rpa.runId,
      revision: run.revision ?? exec.rpa.revision,
      scenarioHash: run.scenarioHash ?? exec.rpa.scenarioHash,
      status: run.status || exec.rpa.status,
      stage: run.stage ?? null,
      workerId: run.workerId ?? exec.rpa.workerId,
      error: run.error ?? null,
      finishedAt: run.finishedAt ?? null,
      portalUrl: client.portalUrl(run) || exec.rpa.portalUrl
    });
  }

  async poll(exec) {
    const pipeline = this.store.pipelines.get(exec.pipelineId);
    if (!pipeline || pipeline.type !== 'rpa') return this.finish(exec, 'expired', { reason: 'pipeline_missing' });
    const client = this.client(pipeline);
    const rp = pipeline.rpa || {};
    let run;
    try {
      run = await client.getRun(exec.rpa.runId);
    } catch (err) {
      if (!(err instanceof RpaError)) throw err;
      exec.lastError = err.message;
      if (err.status === 404) return this.finish(exec, 'expired', { reason: 'run_not_found' });
      if (err.retryable && !this.pastDeadline(exec)) return this.later(exec);
      return this.finish(exec, 'expired', { reason: err.retryable ? 'deadline' : err.code, detail: err.message });
    }
    exec.lastError = null;
    this.absorbRun(exec, run, client);
    if (run.finished || !['queued', 'running'].includes(run.status)) return this.judge(exec, run);
    exec.state = run.status === 'running' ? 'running' : 'submitted';
    const now = this.now();
    if (run.status === 'queued' && exec.submittedAt && now - Date.parse(exec.submittedAt) > (rp.queueTimeoutSec || 300) * 1000) {
      await client.cancelRun(run.id).catch(() => {});
      return this.finish(exec, 'expired', { reason: 'queue_timeout', detail: `排隊超過 ${rp.queueTimeoutSec || 300} 秒，沒有可用的 Worker；運行已取消` });
    }
    if (this.pastDeadline(exec)) {
      if (run.status === 'queued') await client.cancelRun(run.id).catch(() => {});
      return this.finish(exec, 'expired', { reason: 'deadline', detail: `超過整體期限（${exec.deadlineAt}），結果未知；運行 ${run.id}${run.status === 'queued' ? ' 已取消' : ' 仍在執行，可稍後重新讀取'}` });
    }
    this.later(exec);
  }

  /** 判定（§8.4）：只有 passed 且版本、守衛全部對得上才是 pass；其餘都是「無法判定」，不寫回。 */
  async judge(exec, run) {
    const status = run.status;
    if (status === 'needs_login') {
      exec.rpa.role = run.result?.role || exec.rpa.role;
      return this.finish(exec, 'needs_login', { reason: 'needs_login', detail: `登入角色 ${exec.rpa.role || '?'} 需要人工登入；請在 RPA 登入後重試` });
    }
    if (status !== 'passed') {
      const detail = [`RPA 運行 ${status}`, run.stage ? `階段 ${run.stage}` : null, run.error].filter(Boolean).join('：');
      return this.finish(exec, 'done', { verdict: 'inconclusive', reason: `rpa_${status}`, detail });
    }
    if (Number(run.revision) !== exec.rpa.expectedRevision || (run.scenarioHash && run.scenarioHash !== exec.rpa.contentHash)) {
      return this.finish(exec, 'done', { verdict: 'inconclusive', reason: 'revision_changed', detail: `運行用的版本（v${run.revision}，${String(run.scenarioHash || '').slice(0, 12)}）不是審閱版本（v${exec.rpa.expectedRevision}，${String(exec.rpa.contentHash).slice(0, 12)}）` });
    }
    const output = run.output && typeof run.output === 'object' ? run.output : {};
    const object = { id: exec.target.objectId, name: exec.target.objectName, locator: exec.target.locator };
    const checked = evaluateExpect(exec.spec, output, { object, groups: exec.groups });
    if (!checked.ok) {
      const detail = checked.failures.map(f => `${f.output}：期望 ${JSON.stringify(f.expected)}，實際 ${JSON.stringify(f.actual)}`).join('；');
      return this.finish(exec, 'done', { verdict: 'inconclusive', reason: 'expect_failed', detail, failures: checked.failures });
    }
    const summary = exec.spec.check.expect.map(e => (e.nonEmpty ? `${e.output} 非空` : `${e.output} = ${JSON.stringify(output[e.output])}`)).join('；');
    // 先寫回再轉為終態：讀到 done 時寫回效果已經確定
    exec.verdict = 'pass';
    exec.detail = `守衛全部通過：${summary}`;
    exec.evidence = evidenceOf(exec.spec, output);
    const wb = exec.dryRun ? { effect: 'dry_run' } : await this.writeBack(exec);
    this.finish(exec, 'done', { verdict: 'pass', detail: wb.note ? `${exec.detail}；${wb.note}` : exec.detail, effect: wb.effect, level: wb.level ?? null, commit: wb.commit || null, staleReason: wb.staleReason || null });
  }

  /** 寫回（§8.5）：一次 store.tx；目標在執行期間變了就記 stale，不寫。 */
  async writeBack(exec) {
    const runner = { kind: 'pipeline', id: exec.actionId, name: `Action ${exec.actionId} ${exec.actionName || ''}`.trim().slice(0, 80) };
    try {
      const out = await this.store.tx(runner, `[校驗] ${exec.actionId} → ${exec.target.itemId}：pass（RPA 運行 ${exec.rpa.runId}，觸發者 ${exec.requestedBy.id}）`, t => this.store.applyExecutionResult(t, exec, runner));
      const r = out.result;
      return { effect: r.effect, level: r.level, commit: out.commit, staleReason: r.effect === 'stale' ? r.reason : null, note: r.effect === 'stale' ? `未寫回：${r.detail}` : null };
    } catch (err) {
      exec.lastError = err.message;
      return { effect: 'none', note: `寫回失敗：${err.message}` };
    }
  }
}

/** 給 API 返回的精簡視圖。 */
export function executionView(exec) {
  if (!exec) return null;
  const { spec, nextAt, pollMs, ...rest } = exec;
  return { ...rest, stateName: EXECUTION_STATES[exec.state]?.name || exec.state, terminal: terminal(exec.state), statusUrl: `/api/v1/action-executions/${exec.id}` };
}
