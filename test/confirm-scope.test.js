// 金鑰附加權限 assertions:confirm：持有它的 API 金鑰可以在用戶授權後把已審閱的 L1 斷言確認為 L0。
// 全部使用虛構資料（臨時目錄裡的新知識庫），不讀寫任何真實部署的知識。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeStore, AGENT, PIPE } from './helpers.js';

const SCOPE = 'assertions:confirm';
let t;
let producer;
let confirmer;
let confirmerKey;

/** 用管理員會話發放金鑰；返回帶身份的客戶端、金鑰記錄與原文。 */
async function issueKey(body) {
  const r = await t.admin('POST', '/admin/api/keys', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { secret, ...key } = r.body.data;
  return { key, secret, call: (method, p, b) => t.call(method, p, b, { authorization: `Bearer ${secret}` }) };
}

/** 建一個虛構主體與兩條附來源的 L1 斷言。 */
async function fixture(name, { ownerIds } = {}) {
  const s = await producer('POST', '/api/v1/subjects', { name, type: '規則', domain: 'INV', definition: '僅供測試的虛構規則', ...(ownerIds ? { ownerIds } : {}) });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const ids = [];
  for (const content of [`${name}：示例斷言甲`, `${name}：示例斷言乙`]) {
    const a = await producer('POST', `/api/v1/subjects/${s.body.data.id}/assertions`, { type: '規則', content, evidence: { sourceRef: 'fictional://spec/example-001' } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.data.validity.level, 'L1');
    ids.push(a.body.data.id);
  }
  return { subjectId: s.body.data.id, ids };
}

const read = async id => (await producer('GET', `/api/v1/items/${id}`)).body.data;
const selection = async ids => Promise.all(ids.map(async id => ({ id, version: (await read(id)).reviewVersion })));

before(async () => {
  t = await startServer();
  producer = (await issueKey({ name: '虛構生產智能體', kind: 'agent', role: 'contributor' })).call;
  const c = await issueKey({ name: '虛構確認智能體', kind: 'agent', role: 'contributor', scopes: [SCOPE] });
  confirmer = c.call;
  confirmerKey = c;
  assert.deepEqual(c.key.scopes, [SCOPE]);
});
after(() => t.close());

test('無憑證 401；有效金鑰但沒有確認權限 403', async () => {
  const { ids } = await fixture('權限測試主體');
  const items = await selection(ids);
  const endpoints = [
    ['/api/v1/assertions/confirm-batch', { items }],
    ['/api/v1/items/confirm-batch', { items }],
    [`/api/v1/items/${ids[0]}/confirm`, { version: items[0].version }]
  ];
  for (const [p, body] of endpoints) {
    assert.equal((await t.call('POST', p, body)).status, 401, p);
    assert.equal((await t.call('POST', p, body, { authorization: 'Bearer kk_fictional_invalid' })).status, 401, p);
    const denied = await producer('POST', p, body);
    assert.equal(denied.status, 403, p);
    assert.equal(denied.body.error.code, 'forbidden');
    assert.match(denied.body.error.message, /assertions:confirm/);
  }
  const reader = (await issueKey({ name: '虛構只讀智能體', kind: 'agent', role: 'consumer' })).call;
  assert.equal((await reader('POST', '/api/v1/assertions/confirm-batch', { items })).status, 403, '只讀權限不自動獲得確認能力');
  for (const id of ids) assert.equal((await read(id)).validity.level, 'L1');
});

test('授權金鑰確認 L1 → L0：記錄真實身份、審閱版本與說明，重新讀取後層級與統計一致', async () => {
  const { ids } = await fixture('授權確認主體');
  const before = (await producer('GET', '/api/v1/metrics')).body.data.levels.assertion;
  const items = await selection(ids);
  const note = '用戶已審核並明確確認上述斷言晉升為 L0';
  const r = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items, note });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.commit, /^[0-9a-f]{7,}$/);
  assert.deepEqual(r.body.data.map(x => [x.id, x.level, x.method, x.verifiedBy]), ids.map(id => [id, 'L0', 'delegated', confirmerKey.key.id]));

  for (const [i, id] of ids.entries()) {
    const it = await read(id);
    const v = it.validity;
    assert.equal(v.level, 'L0');
    assert.equal(v.method, 'delegated');
    assert.equal(v.verifiedBy, confirmerKey.key.id);
    assert.ok(Date.parse(v.expiresAt) > Date.now(), '有效期按規則參數設定');
    const h = v.history.at(-1);
    assert.deepEqual({ from: h.from, to: h.to, by: h.by, note: h.note, version: h.version, scope: h.scope }, { from: 'L1', to: 'L0', by: confirmerKey.key.id, note, version: items[i].version, scope: SCOPE });
    assert.match(h.reason, /授權確認/);
    assert.ok(!JSON.stringify(it).includes(confirmerKey.secret), '不記錄金鑰原文');
  }
  const after = (await producer('GET', '/api/v1/metrics')).body.data.levels.assertion;
  assert.equal(after.L0, before.L0 + 2);
  assert.equal(after.L1, before.L1 - 2);
  const listed = (await producer('GET', `/api/v1/assertions?level=L0&q=${encodeURIComponent('授權確認主體')}`)).body.data.map(a => a.id);
  for (const id of ids) assert.ok(listed.includes(id));

  const log = (await t.admin('GET', '/admin/api/log?limit=1')).body.data[0];
  assert.equal(log.author, '虛構確認智能體', 'Git 提交作者是金鑰本身，不是負責人');
  assert.match(log.subject, /授權金鑰 虛構確認智能體（agent-[0-9a-f]+，assertions:confirm）/);
  assert.ok(!log.subject.includes(confirmerKey.secret));
});

test('審閱版本過期整批拒絕；層級、證據與已確認都明確說明原因', async () => {
  const { subjectId, ids } = await fixture('業務校驗主體');
  const items = await selection(ids);
  await producer('PATCH', `/api/v1/assertions/${ids[1]}`, { content: '業務校驗主體：示例斷言乙（已更正）' });
  const stale = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_assertion');
  assert.match(stale.body.error.message, /重新整理並核對/);
  for (const id of ids) assert.equal((await read(id)).validity.level, 'L1', '沒有部分成功');

  const noVersion = await confirmer('POST', `/api/v1/items/${ids[0]}/confirm`, { note: '缺少版本' });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.body.error.code, 'version_required');

  const fresh = await selection([ids[0]]);
  const single = await confirmer('POST', `/api/v1/items/${ids[0]}/confirm`, { version: fresh[0].version, note: '單條確認', expiryDays: 36500 });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.equal(single.body.data.method, 'delegated');
  assert.ok(single.body.warnings.some(w => w.includes('已忽略 expiryDays')));
  assert.ok(Date.parse(single.body.data.expiresAt) < Date.now() + 400 * 86400000, '授權確認不能自訂有效期');

  const again = await confirmer('POST', `/api/v1/items/${ids[0]}/confirm`, { version: (await read(ids[0])).reviewVersion });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_confirmed');

  const l2 = await producer('POST', `/api/v1/subjects/${subjectId}/assertions`, { type: '規則', content: '業務校驗主體：沒有證據的猜測' });
  assert.equal(l2.body.data.validity.level, 'L2');
  const noEvidence = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: await selection([l2.body.data.id, ids[1]]) });
  assert.equal(noEvidence.status, 409, 'L2 沒有證據時不能到 L0');
  assert.equal(noEvidence.body.error.code, 'missing_evidence');
  assert.match(noEvidence.body.error.message, /evidence/);
  assert.equal((await read(ids[1])).validity.level, 'L1', '同批的 L1 也沒有生效');

  const e1 = await producer('POST', `/api/v1/subjects/${subjectId}/assertions`, { type: '規則', content: '業務校驗主體：已過時的舊規則', level: 'E1', invalidReason: '虛構：已被新規則取代' });
  const invalid = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: await selection([e1.body.data.id]) });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.error.code, 'invalid_transition');

  const mixed = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: await selection([ids[1], ids[0]]) });
  assert.equal(mixed.status, 409, '一條已是 L0，整批拒絕');
  assert.equal((await read(ids[1])).validity.level, 'L1');

  assert.equal((await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: [{ id: ids[1] }] })).status, 400, '批量每條都要附版本');
});

test('L2 也能確認為 L0：沒有證據時在確認請求中一併提供，已有證據的 L2 直接晉升', async () => {
  const { subjectId } = await fixture('L2 晉升主體');
  const bare = (await producer('POST', `/api/v1/subjects/${subjectId}/assertions`, { type: '規則', content: 'L2 晉升主體：用戶口頭確認的規則' })).body.data;
  const withSource = (await producer('POST', `/api/v1/subjects/${subjectId}/assertions`, { type: '規則', content: 'L2 晉升主體：提交時就附了來源', level: 'L2', evidence: { sourceRef: 'fictional://spec/l2-002' } })).body.data;
  assert.deepEqual([bare.validity.level, withSource.validity.level], ['L2', 'L2']);

  const [a, b] = await selection([bare.id, withSource.id]);
  assert.equal((await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: [{ ...a, evidence: 'fictional' }, b] })).status, 400, 'evidence 必須是物件');
  const unknown = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: [{ ...a, evidence: { objectIds: ['O-9999'] } }, b] });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error.code, 'unknown_object');
  assert.equal((await read(withSource.id)).validity.level, 'L2', '整批回滾');

  const note = '用戶已審閱兩條 L2 斷言並確認晉升';
  const r = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: [{ ...a, evidence: { sourceRef: 'fictional://review/2026-11-26' } }, b], note });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.map(x => x.level), ['L0', 'L0']);

  const v1 = (await read(bare.id)).validity;
  assert.equal(v1.evidence.sourceRef, 'fictional://review/2026-11-26');
  assert.deepEqual(v1.history.slice(-2).map(h => [h.from, h.to, h.by]), [['L2', 'L1', confirmerKey.key.id], ['L1', 'L0', confirmerKey.key.id]]);
  assert.equal(v1.history.at(-2).reason, '補充客體證據');
  assert.equal(v1.history.at(-1).version, a.version, '審計記的是審閱時的版本');
  const v2 = (await read(withSource.id)).validity;
  assert.deepEqual([v2.history.at(-1).from, v2.history.at(-1).to, v2.method], ['L2', 'L0', 'delegated']);

  const l2Owner = (await producer('POST', `/api/v1/subjects/${subjectId}/assertions`, { type: '規則', content: 'L2 晉升主體：負責人確認的 L2' })).body.data;
  const ownerNoEvidence = await t.admin('POST', `/api/v1/items/${l2Owner.id}/confirm`, {});
  assert.equal(ownerNoEvidence.status, 409);
  assert.equal(ownerNoEvidence.body.error.code, 'missing_evidence');
  const ownerOk = await t.admin('POST', `/api/v1/items/${l2Owner.id}/confirm`, { evidence: { sourceRef: 'fictional://owner/review' } });
  assert.equal(ownerOk.status, 200, '負責人同樣可以 L2 → L0');
  assert.equal(ownerOk.body.data.method, 'manual');
});

test('只有斷言確認權限時，不能確認綁定、關係，也不能做其他負責人操作', async () => {
  const { subjectId, ids } = await fixture('越權測試主體');
  const obj = await producer('POST', '/api/v1/objects', { name: '虛構口徑文檔', category: '制度', kind: 'SOP', locator: 'fictional://docs/example' });
  const binding = await producer('POST', `/api/v1/subjects/${subjectId}/bindings`, { objectId: obj.body.data.id });
  assert.equal(binding.body.data.validity.level, 'L1');
  const parent = await producer('POST', '/api/v1/subjects', { name: '越權測試上位規則', type: '規則', domain: 'INV' });
  const rel = await producer('POST', '/api/v1/relations', { from: subjectId, type: '是一種', to: parent.body.data.id, evidence: { sourceRef: 'fictional://arch/example' } });
  assert.equal(rel.status, 201, JSON.stringify(rel.body));
  const bId = binding.body.data.id;
  const rId = rel.body.data.id;

  for (const id of [bId, rId]) {
    const one = await confirmer('POST', `/api/v1/items/${id}/confirm`, { version: (await read(id)).reviewVersion });
    assert.equal(one.status, 403, id);
    assert.equal(one.body.error.code, 'scope_mismatch');
  }
  const viaItems = await confirmer('POST', '/api/v1/items/confirm-batch', { items: await selection([ids[0], bId]) });
  assert.equal(viaItems.status, 403);
  assert.equal(viaItems.body.error.code, 'scope_mismatch');
  const viaAssertions = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: await selection([ids[0], rId]) });
  assert.equal(viaAssertions.status, 403);
  assert.equal(viaAssertions.body.error.code, 'scope_mismatch');
  for (const id of [ids[0], bId, rId]) assert.equal((await read(id)).validity.level, 'L1', `${id} 沒有被晉升`);

  assert.equal((await confirmer('POST', `/api/v1/items/${ids[0]}/invalidate`, { reason: '虛構' })).status, 403);
  assert.equal((await confirmer('POST', '/api/v1/validate-all', {})).status, 403);
  assert.equal((await confirmer('PUT', '/api/v1/config', {})).status, 403);

  const listed = (await confirmer('POST', '/api/v1/items/confirmable', { subjectIds: [subjectId] })).body.data;
  assert.equal(listed.find(x => x.id === ids[0]).canConfirm, true);
  assert.equal(listed.find(x => x.id === bId).canConfirm, false);
  assert.match(listed.find(x => x.id === bId).reason, /只能確認斷言/);

  const guarded = await fixture('指定負責人主體', { ownerIds: ['user-fictional-owner'] });
  const denied = await confirmer('POST', '/api/v1/assertions/confirm-batch', { items: await selection(guarded.ids) });
  assert.equal(denied.status, 403, '有指定負責人的主體仍只限負責人');
  assert.match(denied.body.error.message, /指定負責人/);
});

test('負責人通過後台確認照舊：單條不帶版本可確認與續期，批量帶版本並記入審計', async () => {
  const { ids } = await fixture('負責人兼容主體');
  const one = await t.admin('POST', `/api/v1/items/${ids[0]}/confirm`, { note: '後台確認' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.method, 'manual');
  let v = (await read(ids[0])).validity;
  assert.equal(v.method, 'manual');
  assert.equal(v.history.at(-1).reason, '負責人確認');
  const renew = await t.admin('POST', `/api/v1/items/${ids[0]}/confirm`, {});
  assert.equal(renew.status, 200, '負責人可對 L0 續期');
  v = (await read(ids[0])).validity;
  assert.equal(v.history.at(-1).reason, '重新驗證，延長有效期');

  const owner = (await issueKey({ name: '虛構負責人', kind: 'human', role: 'owner' })).call;
  const items = await selection([ids[1]]);
  const batch = await owner('POST', '/api/v1/items/confirm-batch', { items, note: '負責人批量確認' });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  const h = (await read(ids[1])).validity.history.at(-1);
  assert.equal(h.version, items[0].version);
  assert.equal(h.by, batch.body.data[0].verifiedBy);
  assert.equal(h.scope, undefined);
  const log = (await t.admin('GET', '/admin/api/log?limit=1')).body.data[0];
  assert.match(log.subject, /（負責人 虛構負責人）$/);
});

test('管理員授予與收回權限：只改傳入欄位，立即生效；管道與未知權限被拒絕', async () => {
  const { ids } = await fixture('授予收回主體');
  const k = await issueKey({ name: '虛構待授權智能體', kind: 'agent', role: 'contributor' });
  assert.deepEqual(k.key.scopes, []);
  const items = await selection([ids[0]]);
  assert.equal((await k.call('POST', '/api/v1/assertions/confirm-batch', { items })).status, 403);

  assert.equal((await k.call('PATCH', `/admin/api/keys/${k.key.id}`, { scopes: [SCOPE] })).status, 403, '金鑰不能給自己授權');
  const granted = await t.admin('PATCH', `/admin/api/keys/${k.key.id}`, { scopes: [SCOPE] });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.data.scopes, [SCOPE]);
  assert.ok(granted.body.data.scopesUpdatedAt);
  assert.equal(granted.body.data.disabled, false);
  assert.equal(granted.body.data.hash, undefined);
  assert.equal((await k.call('POST', '/api/v1/assertions/confirm-batch', { items })).status, 200, '授予後立即生效');

  await t.admin('PATCH', `/admin/api/keys/${k.key.id}`, { disabled: true });
  const revoked = await t.admin('PATCH', `/admin/api/keys/${k.key.id}`, { scopes: [] });
  assert.equal(revoked.body.data.disabled, true, '只改 scopes 時不動停用狀態');
  assert.deepEqual(revoked.body.data.scopes, []);
  await t.admin('PATCH', `/admin/api/keys/${k.key.id}`, { disabled: false });
  assert.equal((await k.call('POST', '/api/v1/assertions/confirm-batch', { items: await selection([ids[1]]) })).status, 403, '收回後立即失效');

  const listed = (await t.admin('GET', '/admin/api/keys')).body.data.find(x => x.id === confirmerKey.key.id);
  assert.deepEqual(listed.scopes, [SCOPE]);
  assert.equal((await t.admin('PATCH', `/admin/api/keys/${k.key.id}`, {})).status, 400);
  const pipe = await t.admin('POST', '/admin/api/keys', { name: '虛構管道', kind: 'pipeline', role: 'contributor', scopes: [SCOPE] });
  assert.equal(pipe.status, 400);
  assert.equal(pipe.body.error.code, 'invalid_scope');
  const unknown = await t.admin('PATCH', `/admin/api/keys/${k.key.id}`, { scopes: ['items:confirm'] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'invalid_scope');
  assert.equal((await t.admin('POST', '/admin/api/keys', { name: 'x', kind: 'agent', role: 'owner', scopes: [SCOPE] })).status, 400, '智能體仍不能是負責人');
  // 只疊加在「智能體 + 貢獻者」上：不給只讀智能體、人類金鑰開這條路，也不新增類型或角色
  for (const [kind, role] of [['agent', 'consumer'], ['human', 'contributor'], ['human', 'owner']]) {
    const r = await t.admin('POST', '/admin/api/keys', { name: `虛構 ${kind}-${role}`, kind, role, scopes: [SCOPE] });
    assert.equal(r.status, 400, `${kind}-${role}`);
    assert.equal(r.body.error.code, 'invalid_scope');
    assert.match(r.body.error.message, /智能體 \+ 貢獻者/);
  }
  const human = await issueKey({ name: '虛構人類貢獻者', kind: 'human', role: 'contributor' });
  assert.equal((await t.admin('PATCH', `/admin/api/keys/${human.key.id}`, { scopes: [SCOPE] })).status, 400);
});

test('OpenAPI 與教程說明確認權限與審閱版本', async () => {
  const oa = (await t.call('GET', '/api/v1/openapi.json')).body;
  for (const p of ['/assertions/confirm-batch', '/items/confirm-batch', '/items/{id}/confirm']) {
    assert.deepEqual(oa.paths[p].post['x-scopes'], [SCOPE], p);
    assert.ok(oa.paths[p].post.responses[409], p);
  }
  assert.ok(oa.paths['/items/{id}/confirm'].post.requestBody.content['application/json'].schema.properties.version);
  const prompt = (await t.call('GET', '/api/v1/prompt')).body;
  for (const s of ['assertions:confirm', 'reviewVersion', 'scope_mismatch', '你不能寫入 L0']) assert.ok(prompt.includes(s), s);
  const en = (await t.call('GET', '/api/v1/prompt?lang=en')).body;
  assert.match(en, /Delegated confirmation/);
});

test('存儲層：沒有權限的智能體照舊被拒；管道即使帶 scopes 也不能確認；授權確認同樣要求證據', async () => {
  const { store } = await makeStore();
  const DELEGATE = { ...AGENT, id: 'agent-fictional', scopes: [SCOPE] };
  const { result } = await store.tx(AGENT, '準備', t => {
    const s = store.createSubject(t, { name: '存儲層虛構主體', type: '規則', domain: 'INV' }, AGENT);
    const a = store.createAssertion(t, s.id, { type: '規則', content: '存儲層虛構斷言', evidence: { sourceRef: 'fictional://store/001' } }, AGENT);
    return { a: a.id };
  });
  const version = store.reviewVersion(store.getItem(result.a).item);
  await store.load();
  assert.equal(store.reviewVersion(store.getItem(result.a).item), version, '從磁碟重新載入（回滾、拉取遠端）後審閱版本不變');
  await assert.rejects(store.tx(AGENT, 'c', t => store.confirm(t, result.a, { version }, AGENT)), err => err.code === 'agent_cannot_promote');
  await assert.rejects(store.tx(PIPE, 'c', t => store.confirm(t, result.a, { version }, { ...PIPE, scopes: [SCOPE] })), err => err.status === 403);
  // 證據被移除（例如直接在 Git 裡改過）時，授權確認與負責人確認一樣被拒絕
  store.getItem(result.a).item.validity.evidence = { objectIds: [], actionId: null, sourceRef: null };
  const bare = store.reviewVersion(store.getItem(result.a).item);
  await assert.rejects(store.tx(DELEGATE, 'c', t => store.confirm(t, result.a, { version: bare }, DELEGATE)), err => err.code === 'missing_evidence');
});
