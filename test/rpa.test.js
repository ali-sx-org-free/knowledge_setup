// RPA 管道與 Action 第一期：以模擬的 Agent API 走完註冊、預覽、校驗（異步）、判定與寫回，
// 覆蓋設計文件 docs/design/rpa-integration.md §14 的場景。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer } from './helpers.js';
import { SCENE, LOCATOR, SCENARIO, mockRpa } from './rpa-mock.js';
import { ExecutionService } from '../src/services/executions.js';
import { normalizeRpaAction, evaluateExpect, renderSceneInputs, parseLocator } from '../src/store/rpa.js';
import { parseScenario, draftAction, conformance } from '../src/services/rpa.js';

let t;
let rpa;
let rpaServer;
let rpaBase;
let actionId;
let objectId;
let bindingId;
let subjectId;
let pipelineId;
let agent;

const wait = ms => new Promise(r => setTimeout(r, ms));
async function settle(id, { timeout = 8000, srv = t } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const r = await srv.admin('GET', `/api/v1/action-executions/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.data.terminal) return r.body.data;
    if (Date.now() > until) throw new Error(`執行 ${id} 沒有結束：${JSON.stringify(r.body.data)}`);
    await wait(15);
  }
}
const binding = async () => (await t.admin('GET', `/api/v1/items/${bindingId}`)).body.data;
const EXEC_OPTS = { tickMs: 10, minPollMs: 0, backoffMs: 5 };

before(async () => {
  rpa = mockRpa();
  rpaServer = await new Promise(resolve => { const s = rpa.app.listen(0, '127.0.0.1', () => resolve(s)); });
  rpaBase = `http://127.0.0.1:${rpaServer.address().port}`;
  t = await startServer({ env: { RPA_TOKEN: 'test-key' }, executions: EXEC_OPTS });
  agent = await t.keyFor('agent', 'contributor', 'RPA 測試智能體');
});
after(async () => {
  await t.close();
  await new Promise(r => rpaServer.close(r));
});
beforeEach(() => rpa?.m.reset());

test('純函數：場景契約、可註冊規範、草稿與守衛', () => {
  const contract = parseScenario(SCENARIO);
  assert.equal(contract.loginRole, 'dev4dms');
  assert.equal(contract.deadlineMs, 120000);
  assert.equal(contract.verifyCount, 2);
  assert.deepEqual(contract.inputs.environment.enum, ['生產', '預發']);
  const scene = { id: SCENE, name: 'x', publishedRevision: 2 };
  const rules = conformance(scene, contract, [{ id: 'dev4dms', status: 'needs_login' }]);
  assert.ok(rules.some(x => x.rule === 'R5' && x.level === 'warn'));
  assert.ok(conformance(scene, contract, []).some(x => x.rule === 'R5' && x.level === 'error'), '角色未綁定給 API 用戶端時是錯誤');
  const draft = draftAction({ pipelineId: 'P-0001', scene, revision: { number: 2, contentHash: 'hash-v2' }, contract, objectKind: '數據表' });
  assert.deepEqual(draft.rpa.inputs, { databasePrefix: '{locator.databasePrefix}', tableName: '{locator.tableName}', environment: '生產' });
  assert.deepEqual(draft.check.expect.map(e => e.output), ['databaseName', 'environment', 'tableName', 'createTableSql']);
  assert.deepEqual(draft.evidence, { keep: ['databaseName', 'environment', 'tableName'], digest: ['createTableSql'] });
  const spec = { id: 'ACT-X', ...normalizeRpaAction({ ...draft, locator: { pattern: draft.locator.pattern, example: LOCATOR } }) };
  const groups = parseLocator(spec, LOCATOR);
  assert.deepEqual(groups, { databasePrefix: 'adb_wdk_scm_dpartner', tableName: 'replenish_order' });
  assert.deepEqual(renderSceneInputs(spec, { groups }, contract).problems, []);
  assert.throws(() => parseLocator(spec, 'replenish_order'), /不符合/);
  const out = { databaseName: 'adb_wdk_scm_dpartner', environment: '預發', tableName: 'replenish_order', createTableSql: 'CREATE TABLE x' };
  assert.deepEqual(evaluateExpect(spec, out, { groups }).failures.map(f => f.output), ['environment']);
  assert.throws(() => normalizeRpaAction({ ...draft, rpa: { ...draft.rpa, inputs: { tableName: '{input.table}' } } }), /不接受調用者入參/);
  assert.throws(() => normalizeRpaAction({ ...draft, check: { mode: 'exists', expect: [] } }), /至少要有一項守衛/);
});

test('註冊：管道體檢、場景目錄、草稿、審閱後才能啟用、掛到客體', async () => {
  const p = await t.admin('POST', '/api/v1/pipelines', { name: 'RPA（開發環境）', type: 'rpa', baseUrl: rpaBase, headers: { authorization: 'Bearer ${env:RPA_TOKEN}' }, rpa: { pollIntervalMs: 10, maxPollIntervalMs: 20, queueTimeoutSec: 30, portalUrl: 'http://rpa.portal' } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  pipelineId = p.body.data.id;
  assert.equal(p.body.data.baseUrl, `${rpaBase}/agent-api/v1`);
  const plain = await t.admin('POST', '/api/v1/pipelines', { name: 'x', type: 'rpa', baseUrl: rpaBase, headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } });
  assert.equal(plain.body.error?.code, 'secret_in_repo', '憑證不能明文寫進知識倉庫');

  const test1 = await t.admin('POST', `/api/v1/pipelines/${pipelineId}/test`);
  assert.equal(test1.body.data.ok, true, JSON.stringify(test1.body));
  assert.ok(test1.body.data.checks.some(c => c.level === 'warn' && c.text.includes('debug')), '多餘權限要警告');
  rpa.m.scopes = ['scenes:read', 'runs:read'];
  const test2 = await t.admin('POST', `/api/v1/pipelines/${pipelineId}/test`);
  assert.equal(test2.body.data.ok, false);
  assert.match(test2.body.data.detail, /runs:execute/);
  rpa.m.scopes = ['scenes:read', 'runs:execute', 'runs:read'];

  const scenes = await t.admin('GET', `/api/v1/pipelines/${pipelineId}/scenes`);
  assert.equal(scenes.status, 200, JSON.stringify(scenes.body));
  assert.deepEqual(scenes.body.data.map(s => s.id), [SCENE], '只列已發布、未歸檔的場景');
  const detail = await t.admin('GET', `/api/v1/pipelines/${pipelineId}/scenes/${SCENE}?objectKind=數據表`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.data.revision.contentHash, 'hash-v2');
  assert.ok(detail.body.data.conformance.every(c => c.level !== 'error'), JSON.stringify(detail.body.data.conformance));
  const draft = detail.body.data.draft;
  assert.equal(draft.rpa.revision, 2);
  assert.equal((await t.admin('GET', `/api/v1/pipelines/${pipelineId}/scenes/nope`)).status, 404);

  const noReview = await t.admin('POST', '/api/v1/actions', { ...draft, locator: { ...draft.locator, example: LOCATOR } });
  assert.equal(noReview.body.error?.code, 'review_required', '沒審閱不能啟用');
  const a = await t.admin('POST', '/api/v1/actions', { ...draft, locator: { ...draft.locator, example: LOCATOR }, review: { readOnly: true } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  actionId = a.body.data.id;
  assert.equal(a.body.data.review.by, 'admin');
  assert.equal(a.body.data.permission, 'contributor');

  const o = await t.admin('POST', '/api/v1/objects', { name: '數據表 replenish_order', category: '數字', kind: '數據表', locator: LOCATOR, actionIds: [actionId] });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  objectId = o.body.data.id;
  const s = await t.admin('POST', '/api/v1/subjects', { name: '補貨單', type: '業務對象', domain: 'PLN', definition: '補貨計劃生成的補貨單' });
  subjectId = s.body.data.id;
  const b = await t.admin('POST', `/api/v1/subjects/${subjectId}/bindings`, { objectId });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  bindingId = b.body.data.id;
  assert.equal(b.body.data.validity.level, 'L1');

  const preview = await t.admin('POST', `/api/v1/actions/${actionId}/preview`, { objectId });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.inputs, { databasePrefix: 'adb_wdk_scm_dpartner', tableName: 'replenish_order', environment: '生產' });
  assert.deepEqual(preview.body.data.problems, []);
  const bad = await t.admin('POST', `/api/v1/actions/${actionId}/preview`, { locator: 'replenish_order' });
  assert.equal(bad.body.data.problems[0].code, 'locator_invalid');
  assert.equal(rpa.m.runs.size, 0, '註冊與預覽都不派發運行');
});

test('校驗：202 受理，異步執行，守衛通過後 L1 → L0 並留下運行證據（一次 Git 提交）', async () => {
  const r = await agent('POST', `/api/v1/validate/${bindingId}`, { actionId });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.data.state, 'accepted');
  const again = await agent('POST', `/api/v1/validate/${bindingId}`, { actionId });
  assert.equal(again.body.data.executionId, r.body.data.executionId, '防雙擊：返回同一個執行');
  assert.equal(again.body.data.deduped, true);
  const exec = await settle(r.body.data.executionId);
  assert.equal(exec.state, 'done');
  assert.equal(exec.verdict, 'pass', JSON.stringify(exec));
  assert.equal(exec.effect, 'promoted_L0');
  assert.ok(exec.commit);
  assert.equal(rpa.m.runs.size, 1);
  const run = [...rpa.m.runs.values()][0];
  assert.equal(run.body.expectedRevision, 2);
  assert.equal(run.body.idempotencyKey, `kb:${exec.id}`);
  assert.deepEqual(run.body.inputs, { databasePrefix: 'adb_wdk_scm_dpartner', tableName: 'replenish_order', environment: '生產' });
  assert.equal(exec.rpa.portalUrl, `http://rpa.portal/runs/${run.id}`);
  const b = await binding();
  assert.equal(b.validity.level, 'L0');
  assert.equal(b.validity.lastCheck.executionId, exec.id);
  assert.equal(b.validity.lastCheck.rpa.runId, run.id);
  assert.equal(b.validity.lastCheck.rpa.outputs.tableName, 'replenish_order');
  assert.equal(b.validity.lastCheck.rpa.digests.createTableSql.length, run.output.createTableSql.length);
  assert.equal(b.validity.lastCheck.rpa.outputs.createTableSql, undefined, '建表語句全文不進知識倉庫');
  const log = execFileSync('git', ['-C', t.srv.ctx.store.repo.dir, 'log', '-1', '--format=%s%n%an']).toString();
  assert.match(log, new RegExp(`\\[校驗\\] ${actionId} → ${bindingId}：pass（RPA 運行 ${run.id}`));
  const list = await t.admin('GET', `/api/v1/action-executions?itemId=${bindingId}`);
  assert.equal(list.body.data[0].id, exec.id);

  const renew = await agent('POST', `/api/v1/validate/${bindingId}`, { actionId });
  const second = await settle(renew.body.data.executionId);
  assert.equal(second.effect, 'renewed_L0');
});

test('無法判定不寫回：錯誤環境、表名不同、RPA 失敗、版本雜湊不符', async () => {
  const before = (await binding()).validity;
  const cases = [
    [run => ({ status: 'passed', output: { ...mockRpa.defaultFinish(run).output, environment: '預發' } }), 'expect_failed'],
    [run => ({ status: 'passed', output: { ...mockRpa.defaultFinish(run).output, tableName: 'replenish_order_bak' } }), 'expect_failed'],
    [run => ({ status: 'passed', output: { ...mockRpa.defaultFinish(run).output, createTableSql: '' } }), 'expect_failed'],
    [() => ({ status: 'failed', error: '找不到 SQL 視窗', stage: 'execute' }), 'rpa_failed'],
    [() => ({ status: 'timed_out' }), 'rpa_timed_out'],
    [run => ({ ...mockRpa.defaultFinish(run), scenarioHash: 'hash-other' }), 'revision_changed']
  ];
  for (const [finish, reason] of cases) {
    rpa.m.finish = finish;
    const r = await agent('POST', `/api/v1/validate/${bindingId}`, { actionId });
    const exec = await settle(r.body.data.executionId);
    assert.equal(exec.state, 'done');
    assert.equal(exec.verdict, 'inconclusive', reason);
    assert.equal(exec.reason, reason, JSON.stringify(exec));
    assert.equal(exec.effect, null);
  }
  const after = (await binding()).validity;
  assert.equal(after.level, before.level);
  assert.equal(after.lastCheck.executionId, before.lastCheck.executionId, '無法判定不寫 Git');
});

test('拒絕與等待：版本變了、需要登入、409、舊版 RPA、429 與 5xx 重試、一直排隊', async () => {
  // 發布版本不是審閱版本：不派發
  rpa.m.scene.publishedRevision = 3;
  let exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.deepEqual([exec.state, exec.reason], ['rejected', 'revision_changed']);
  assert.equal(rpa.m.runs.size, 0);
  rpa.m.reset();

  // 登入角色需要登入：不消耗運行
  rpa.m.roles[0].status = 'needs_login';
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.deepEqual([exec.state, exec.rpa.role], ['needs_login', 'dev4dms']);
  assert.equal(rpa.m.runs.size, 0);
  rpa.m.reset();

  // 運行停在 needs_login
  rpa.m.finish = () => ({ status: 'needs_login' });
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.equal(exec.state, 'needs_login');
  rpa.m.reset();

  // 預檢後發布切換：RPA 原子比對 409 revision_mismatch，不建立運行
  rpa.m.runRevision = 3;
  const runsBefore = rpa.m.runs.size;
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.deepEqual([exec.state, exec.reason], ['rejected', 'revision_changed']);
  assert.equal(rpa.m.runs.size, runsBefore);
  rpa.m.reset();

  // 舊版 RPA 不認識 expectedRevision：自動改用 202 後比對，版本不符就取消
  rpa.m.supportsExpected = false;
  rpa.m.runRevision = 3;
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.deepEqual([exec.state, exec.reason], ['rejected', 'revision_changed']);
  assert.equal(rpa.m.runs.get(exec.rpa.runId).cancelled, true, '已取消運行');
  rpa.m.reset();
  rpa.m.supportsExpected = false;
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.equal(exec.verdict, 'pass', '舊版 RPA 照常可用');
  assert.equal(rpa.m.runs.get(exec.rpa.runId).body.expectedRevision, undefined);
  t.srv.ctx.executions.legacy.clear();
  rpa.m.reset();

  // 403：權限不足 → rejected，帶 RPA 錯誤碼
  rpa.m.failures = [{ status: 403, body: { error: { code: 'login_role_forbidden', message: '角色沒有綁定' } } }];
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.deepEqual([exec.state, exec.reason], ['rejected', 'login_role_forbidden']);

  // 422 inputs_invalid 帶 problems
  rpa.m.failures = [{ status: 422, body: { error: { code: 'inputs_invalid', message: '入參不符', problems: [{ name: 'tableName', message: '格式不符' }] } } }];
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.deepEqual([exec.state, exec.reason], ['rejected', 'inputs_invalid']);
  assert.equal(exec.problems[0].name, 'tableName');

  // 429、503：同一個冪等鍵退避重試，只產生一個運行
  const count = rpa.m.runs.size;
  rpa.m.failures = [{ status: 429, body: { error: { code: 'limit_reached', message: '排隊已滿' } } }, { status: 503, body: { error: { code: 'unavailable', message: '維護中' } } }];
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId);
  assert.equal(exec.verdict, 'pass', JSON.stringify(exec));
  assert.equal(exec.attempts, 3);
  assert.equal(rpa.m.runs.size, count + 1);

  // 一直排隊：超過 queueTimeoutSec 取消，expired
  await t.admin('PUT', `/api/v1/pipelines/${pipelineId}`, { name: 'RPA（開發環境）', type: 'rpa', baseUrl: rpaBase, headers: { authorization: 'Bearer ${env:RPA_TOKEN}' }, rpa: { pollIntervalMs: 10, maxPollIntervalMs: 20, queueTimeoutSec: 1, portalUrl: 'http://rpa.portal' } });
  rpa.m.pollsToStart = -1;
  rpa.m.hold = true;
  exec = await settle((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId, { timeout: 5000 });
  assert.deepEqual([exec.state, exec.reason], ['expired', 'queue_timeout']);
  assert.equal(rpa.m.runs.get(exec.rpa.runId).cancelled, true);
  await t.admin('PUT', `/api/v1/pipelines/${pipelineId}`, { name: 'RPA（開發環境）', type: 'rpa', baseUrl: rpaBase, headers: { authorization: 'Bearer ${env:RPA_TOKEN}' }, rpa: { pollIntervalMs: 10, maxPollIntervalMs: 20, queueTimeoutSec: 30, portalUrl: 'http://rpa.portal' } });
});

test('過期檢查：執行期間客體定位被改，結果不寫回（stale）', async () => {
  rpa.m.hold = true;
  const r = await agent('POST', `/api/v1/validate/${bindingId}`, { actionId });
  const id = r.body.data.executionId;
  for (let i = 0; i < 200 && (await t.admin('GET', `/api/v1/action-executions/${id}`)).body.data.state !== 'running'; i++) await wait(10);
  const moved = await t.admin('PATCH', `/api/v1/objects/${objectId}`, { locator: 'adb_wdk_scm_dpartner.replenish_order_v2' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  rpa.m.hold = false;
  const exec = await settle(id);
  assert.equal(exec.verdict, 'pass');
  assert.equal(exec.effect, 'stale');
  assert.equal(exec.staleReason, 'object_changed');
  assert.equal((await binding()).validity.level, 'L1', '定位變更已降 L1，舊結果不能再升回 L0');
  await t.admin('PATCH', `/api/v1/objects/${objectId}`, { locator: LOCATOR });
});

test('超過整體期限：expired 保留運行 ID；運行結束後「重新讀取原運行」照常判定寫回', async () => {
  const pipe = { name: 'RPA（開發環境）', type: 'rpa', baseUrl: rpaBase, headers: { authorization: 'Bearer ${env:RPA_TOKEN}' }, rpa: { pollIntervalMs: 10, maxPollIntervalMs: 20, queueTimeoutSec: 30, portalUrl: 'http://rpa.portal' } };
  await t.admin('PUT', `/api/v1/pipelines/${pipelineId}`, { ...pipe, rpa: { ...pipe.rpa, deadlineSec: 1 } });
  rpa.m.hold = true;
  const id = (await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.data.executionId;
  let exec = await settle(id, { timeout: 5000 });
  assert.deepEqual([exec.state, exec.reason], ['expired', 'deadline']);
  assert.ok(exec.rpa.runId);
  assert.notEqual(rpa.m.runs.get(exec.rpa.runId).cancelled, true, '已在執行的運行不取消');
  rpa.m.hold = false;
  await t.admin('PUT', `/api/v1/pipelines/${pipelineId}`, pipe);
  const again = await agent('POST', `/api/v1/action-executions/${id}/refresh`);
  assert.equal(again.status, 202, JSON.stringify(again.body));
  exec = await settle(id);
  assert.deepEqual([exec.state, exec.verdict], ['done', 'pass']);
  assert.equal(exec.effect, 'promoted_L0', '定位已恢復但仍是 L1，結果照常寫回');
  assert.equal((await agent('POST', `/api/v1/action-executions/${id}/refresh`)).status, 409);
});

test('受理前的同步檢查：定位不符 400、沒掛載 422、消費者 403、Action 停用、定期校驗跳過 RPA', async () => {
  const o2 = await t.admin('POST', '/api/v1/objects', { name: '寫錯定位的表', category: '數字', kind: '數據表', locator: 'replenish_order', actionIds: [actionId] });
  const b2 = await t.admin('POST', `/api/v1/subjects/${subjectId}/bindings`, { objectId: o2.body.data.id });
  const bad = await agent('POST', `/api/v1/validate/${b2.body.data.id}`, { actionId });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'locator_invalid');
  assert.match(bad.body.error.message, /adb_wdk_scm_dpartner\.replenish_order/, '提示正確格式');

  const o3 = await t.admin('POST', '/api/v1/objects', { name: '沒掛 Action 的表', category: '數字', kind: '數據表', locator: 'adb_x.y' });
  const b3 = await t.admin('POST', `/api/v1/subjects/${subjectId}/bindings`, { objectId: o3.body.data.id });
  const na = await agent('POST', `/api/v1/validate/${b3.body.data.id}`, { actionId });
  assert.equal(na.status, 422);
  assert.equal(na.body.error.code, 'action_not_attached');

  const consumer = await t.keyFor('agent', 'consumer', 'RPA 消費者');
  assert.equal((await consumer('POST', `/api/v1/validate/${bindingId}`, { actionId })).status, 403);

  const all = await t.admin('POST', '/api/v1/validate-all', {});
  assert.ok(all.body.data.skippedIds.includes(bindingId), 'RPA 校驗第一期不參與定期校驗');
  assert.equal(rpa.m.runs.size, 0);

  const action = (await t.admin('GET', '/api/v1/actions')).body.data.find(a => a.id === actionId);
  const off = await t.admin('PUT', `/api/v1/actions/${actionId}`, { ...action, enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await agent('POST', `/api/v1/validate/${bindingId}`, { actionId })).body.error.code, 'action_disabled');
  await t.admin('PUT', `/api/v1/actions/${actionId}`, { ...action, enabled: true });
});

test('審閱新版本與試運行：鎖到新發布版本；試運行不寫回', async () => {
  rpa.m.scene.publishedRevision = 3;
  const needs = await t.admin('GET', `/api/v1/pipelines/${pipelineId}/scenes`);
  assert.equal(needs.body.data[0].actions[0].needsReview, true, '場景發布了新版本，Action 顯示版本待審');
  assert.equal((await t.admin('POST', `/api/v1/actions/${actionId}/review`, {})).body.error.code, 'review_required');
  const reviewed = await t.admin('POST', `/api/v1/actions/${actionId}/review`, { readOnly: true });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.deepEqual([reviewed.body.data.rpa.revision, reviewed.body.data.rpa.contentHash], [3, 'hash-v3']);
  const before = (await binding()).validity;
  const trial = await t.admin('POST', `/api/v1/actions/${actionId}/trial`, { objectId });
  assert.equal(trial.status, 202, JSON.stringify(trial.body));
  const exec = await settle(trial.body.data.executionId);
  assert.deepEqual([exec.verdict, exec.effect, exec.dryRun], ['pass', 'dry_run', true]);
  assert.equal(rpa.m.runs.get(exec.rpa.runId).body.expectedRevision, 3);
  assert.deepEqual((await binding()).validity.lastCheck, before.lastCheck, '試運行不寫回');
});

test('重啟恢復：RPA 不可用時留在 accepted；重啟後用原冪等鍵繼續，結果照常寫回', async () => {
  rpa.m.scene.publishedRevision = 3; // 上一個測試已把 Action 審閱到 v3
  rpa.m.down = true;
  const r = await agent('POST', `/api/v1/validate/${bindingId}`, { actionId });
  const id = r.body.data.executionId;
  await wait(60);
  assert.equal((await t.admin('GET', `/api/v1/action-executions/${id}`)).body.data.state, 'accepted');
  await t.close();
  rpa.m.down = false;
  t = await startServer({ env: { RPA_TOKEN: 'test-key' }, executions: EXEC_OPTS, dataDir: t.dataDir });
  const exec = await settle(id);
  assert.equal(exec.verdict, 'pass', JSON.stringify(exec));
  assert.ok(['promoted_L0', 'renewed_L0'].includes(exec.effect), exec.effect);
  assert.equal([...rpa.m.runs.values()].filter(x => x.body.idempotencyKey === `kb:${id}`).length, 1);
});

test('執行記錄的保留期：過期與超量的終態記錄被清理，未結束的保留', async () => {
  const dir = `${t.dataDir}/executions-prune`;
  const svc = new ExecutionService({ store: t.srv.ctx.store, dir, tickMs: 0, retentionDays: 1, maxRecords: 1, logger: { warn() {} } });
  await svc.init();
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const mk = (id, state, createdAt) => ({ id, state, createdAt, target: {}, rpa: {} });
  for (const e of [mk('EX-1-a', 'done', old), mk('EX-2-b', 'done', new Date(Date.now() - 1000).toISOString()), mk('EX-3-c', 'done', new Date().toISOString()), mk('EX-4-d', 'submitted', old)]) {
    svc.records.set(e.id, e);
    await svc.save(e);
  }
  assert.equal(await svc.prune(), 2);
  assert.deepEqual([...svc.records.keys()].sort(), ['EX-3-c', 'EX-4-d']);
  await svc.stop();
});
