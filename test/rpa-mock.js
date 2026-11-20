// 測試用的模擬 RPA Agent API（/agent-api/v1），rpa.test.js 與手動驗收共用。
import express from 'express';

export const SCENE = 'tech-dms-sql-show-create-table';
export const LOCATOR = 'adb_wdk_scm_dpartner.replenish_order';
export const SCENARIO = `id: ${SCENE}
name: DMS 查詢建表語句
description: 在 DMS 的 SQL 視窗執行 SHOW CREATE TABLE
login:
  role: dev4dms
deadline: 120000
inputs:
  databasePrefix:
    type: string
    description: 庫名前綴
  environment:
    type: string
    enum: [生產, 預發]
    default: 生產
  tableName:
    type: string
    pattern: "^[a-z0-9_]+$"
outputs:
  databaseName: { type: string }
  environment: { type: string }
  tableName: { type: string }
  createTableSql: { type: string }
verify:
  - output: createTableSql
    contains: CREATE TABLE
  - output: tableName
    equals: "{inputs.tableName}"
steps: []
`;

/** 模擬 RPA 的 Agent API（/agent-api/v1）：場景、版本、角色、運行與冪等鍵。 */
export function mockRpa() {
  const m = {
    scopes: ['scenes:read', 'runs:execute', 'runs:read', 'debug'],
    pageContent: false,
    scene: { id: SCENE, name: 'DMS 查詢建表語句', category: 'tech', domainId: 'tech', publishedRevision: 2, latestRevision: 2, archived: false },
    revisions: { 2: { sceneId: SCENE, number: 2, contentHash: 'hash-v2', status: 'published', files: { 'scenario.yaml': SCENARIO } }, 3: { sceneId: SCENE, number: 3, contentHash: 'hash-v3', status: 'published', files: { 'scenario.yaml': SCENARIO } } },
    roles: [{ id: 'dev4dms', name: 'DMS 開發', status: 'logged_in' }],
    supportsExpected: true,
    runRevision: null, // 運行實際用的版本（模擬發布在預檢後切換）
    pollsToStart: 1,
    pollsToFinish: 2,
    finish: run => ({ status: 'passed', output: { databaseName: run.input.databasePrefix, environment: run.input.environment, tableName: run.input.tableName, createTableSql: `CREATE TABLE \`${run.input.tableName}\` (id bigint)` } }),
    hold: false, // true 時運行一直停在 running
    failures: [], // 依序對 POST runs 的強制回應 [{ status, body }]
    down: false,
    runs: new Map(),
    keys: new Map(),
    seq: 0,
    calls: [],
    reset() {
      Object.assign(this, { supportsExpected: true, runRevision: null, pollsToStart: 1, pollsToFinish: 2, hold: false, failures: [], down: false, pageContent: false });
      this.scene.publishedRevision = 2;
      this.scene.archived = false;
      this.roles[0].status = 'logged_in';
      this.finish = mockRpa.defaultFinish;
      this.calls.length = 0;
      this.runs.clear();
      this.keys.clear();
    }
  };
  mockRpa.defaultFinish = m.finish;
  const app = express();
  app.use(express.json());
  const err = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
  app.use((req, res, next) => {
    m.calls.push(`${req.method} ${req.path}`);
    if (m.down) return err(res, 503, 'unavailable', '維護中');
    if (req.headers.authorization !== 'Bearer test-key') return err(res, 401, 'unauthorized', '金鑰無效');
    next();
  });
  const r = express.Router();
  r.get('/meta', (req, res) => res.json({ apiVersion: '1', serverVersion: '0.10.0', client: { id: 'kb', name: '知識庫' }, scopes: m.scopes, pageContent: m.pageContent, limits: { queuedRuns: 5 }, domains: ['tech'], target: 'any', workers: null, expiresAt: null }));
  r.get('/workers', (req, res) => res.json({ workers: [{ id: 'local', name: '本機', status: 'online' }] }));
  r.get('/roles', (req, res) => res.json({ roles: m.roles }));
  r.get('/scenes', (req, res) => res.json({ scenes: [m.scene, { id: 'draft-only', name: '未發布', publishedRevision: null, latestRevision: 1, archived: false }] }));
  r.get('/scenes/:id', (req, res) => (req.params.id === SCENE ? res.json({ ...m.scene, revisions: Object.values(m.revisions) }) : err(res, 404, 'scene_not_found', '找不到場景')));
  r.get('/scenes/:id/revisions/:n', (req, res) => (m.revisions[req.params.n] ? res.json(m.revisions[req.params.n]) : err(res, 404, 'revision_not_found', '找不到版本')));
  r.post('/scenes/:id/runs', (req, res) => {
    const forced = m.failures.shift();
    if (forced) return res.status(forced.status).json(forced.body);
    const body = req.body || {};
    if (!m.supportsExpected && 'expectedRevision' in body) return err(res, 422, 'request_invalid', '請求格式不對', { problems: [{ field: 'body.expectedRevision', message: 'Extra inputs are not permitted' }] });
    if (body.idempotencyKey && m.keys.has(body.idempotencyKey)) return res.status(202).json(m.runs.get(m.keys.get(body.idempotencyKey)));
    if (!m.scene.publishedRevision) return err(res, 409, 'not_published', '未發布');
    const revision = m.runRevision || m.scene.publishedRevision;
    if (body.expectedRevision && body.expectedRevision !== revision) return err(res, 409, 'revision_mismatch', '版本不符', { revision, expected: body.expectedRevision });
    const id = `${SCENE}-${++m.seq}`;
    const run = { id, sceneId: SCENE, revision, status: 'queued', stage: null, input: body.inputs, output: null, error: null, scenarioHash: m.revisions[revision].contentHash, finished: false, workerId: null, finishedAt: null, polls: 0, body };
    m.runs.set(id, run);
    if (body.idempotencyKey) m.keys.set(body.idempotencyKey, id);
    res.status(202).json(run);
  });
  r.get('/runs/:id', (req, res) => {
    const run = m.runs.get(req.params.id);
    if (!run) return err(res, 404, 'run_not_found', '找不到運行');
    if (!run.finished && run.status !== 'cancelled') {
      run.polls += 1;
      if (run.polls >= m.pollsToStart && m.pollsToStart >= 0) Object.assign(run, { status: 'running', workerId: 'local', stage: 'execute' });
      if (!m.hold && run.polls >= m.pollsToFinish) Object.assign(run, m.finish(run), { finished: true, finishedAt: new Date().toISOString(), stage: null });
    }
    res.json({ ...run, result: run.status === 'needs_login' ? { role: 'dev4dms' } : null });
  });
  r.post('/runs/:id/cancel', (req, res) => {
    const run = m.runs.get(req.params.id);
    if (!run) return err(res, 404, 'run_not_found', '找不到運行');
    Object.assign(run, { status: 'cancelled', finished: true, cancelled: true });
    res.json(run);
  });
  app.use('/agent-api/v1', r);
  return { m, app };
}
