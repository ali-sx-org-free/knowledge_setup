// 主體管理交互（設計 docs/design/subject-management.md）：多值篩選與排除、聯動計數、排序分頁、批量整理與撤銷、
// 批量校驗與確認、導出、查重、導入、批量關係、標籤共用、我的視圖與偏好，以及 5000 個主體時的查詢耗時。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeStore, ADMIN } from './helpers.js';

let t;
let agent;
let consumer;
const OWNERS = ['王敏', '李強', '陳靜', '', '劉洋'];
const TAGS = ['口徑', '核心', '草案'];
const DOMAINS = ['INV', 'ORD', 'WMS', 'TMS', 'PLN'];
const TYPES = ['系統', '業務對象', '流程', '規則', '指標'];
const row = n => ({
  name: `管理測試 ${String(n).padStart(4, '0')}`,
  type: TYPES[n % TYPES.length],
  domain: DOMAINS[n % DOMAINS.length],
  definition: n % 4 ? `第 ${n} 個主體` : '',
  owner: OWNERS[Math.floor(n / 5) % OWNERS.length],
  tags: TAGS.filter((_, k) => (n + k) % 3 === 0).join(','),
  errorCost: String((n % 5) + 1),
  aliases: n % 50 === 0 ? `管理別名 ${n}` : ''
});

before(async () => {
  t = await startServer();
  assert.equal((await t.admin('POST', '/admin/api/seed')).status, 201);
  agent = await t.keyFor('agent', 'contributor');
  consumer = await t.keyFor('agent', 'consumer', 'reader');
  for (let b = 0; b < 2; b++) {
    const rows = Array.from({ length: 300 }, (_, i) => row(b * 300 + i));
    const r = await agent('POST', '/api/v1/subjects/import', { rows });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 400));
    assert.equal(r.body.data.created.length, 300);
  }
});
after(() => t.close());

const list = async (query, who = consumer) => {
  const r = await who('GET', `/api/v1/subjects?${new URLSearchParams(query)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return r.body;
};
const facets = async query => (await consumer('GET', `/api/v1/subjects/facets?${new URLSearchParams(query)}`)).body.data;
const card = async id => (await consumer('GET', `/api/v1/subjects/${id}`)).body.data;

test('多值篩選、排除、分頁與 page.total：超過 500 個主體時分頁取全', async () => {
  const first = await list({ view: 'all' });
  const total = first.page.total;
  assert.ok(total > 600, `total=${total}`);
  assert.equal(first.data.length, 500, '預設每頁 500');
  const second = await list({ view: 'all', offset: 500, limit: 500 });
  assert.equal(second.data.length, total - 500);
  const ids = new Set([...first.data, ...second.data].map(s => s.id));
  assert.equal(ids.size, total, '兩頁不重複、不遺漏');
  assert.ok(![...first.data, ...second.data].some(s => s.type === '別名'), '視圖預設不含別名');

  const two = await list({ view: 'all', domain: 'INV,ORD', limit: 1000 });
  assert.ok(two.data.length > 0 && two.data.every(s => ['INV', 'ORD'].includes(s.domain)));
  const notInv = await list({ view: 'all', domain: '!INV', limit: 1000 });
  assert.ok(notInv.data.every(s => s.domain !== 'INV'));
  const inv = await list({ view: 'all', domain: 'INV', limit: 1 });
  assert.equal(inv.page.total + notInv.page.total, total, '選中與排除互補');

  const noOwner = await list({ view: 'all', owner: 'none', limit: 1000 });
  assert.ok(noOwner.data.length > 0 && noOwner.data.every(s => !s.owner));
  const flagged = await list({ view: 'all', state: 'no_owner', limit: 1 });
  assert.equal(flagged.page.total, noOwner.page.total, 'owner=none 與 state=no_owner 一致');

  const tagged = await list({ view: 'all', tag: '口徑', limit: 1000 });
  assert.ok(tagged.data.length > 0 && tagged.data.every(s => s.tags.includes('口徑')));
  const picked = await list({ view: 'all', ids: `${first.data[3].id},${first.data[7].id}` });
  assert.deepEqual(picked.data.map(s => s.id).sort(), [first.data[3].id, first.data[7].id].sort());

  const withAliases = await list({ view: 'all', type: '別名', limit: 1000 });
  assert.ok(withAliases.data.length >= 12 && withAliases.data.every(s => s.type === '別名'), '類型含別名時才列出別名');
  assert.ok(withAliases.data.some(s => s.name === '管理別名 0' && s.aliasOf?.length), JSON.stringify(withAliases.data[0]));

  assert.equal((await consumer('GET', '/api/v1/subjects?state=bogus')).status, 400);
  assert.equal((await consumer('GET', '/api/v1/subjects?sort=bogus')).status, 400);
  // 舊用法不變：不帶 view 時仍包含別名，單值條件可用
  const legacy = await list({ q: '管理別名 50' });
  assert.ok(legacy.data.some(s => s.name === '管理別名 50'));
});

test('排序：名稱、ID 倒序、優先級', async () => {
  const byId = (await list({ view: 'all', sort: '-id', limit: 50 })).data.map(s => s.id);
  assert.deepEqual(byId, [...byId].sort().reverse());
  const byCost = (await list({ view: 'all', domain: 'TMS', sort: 'priority', limit: 1000 })).data;
  assert.ok(byCost.length > 10);
  const names = (await list({ view: 'all', q: '管理測試', sort: 'name', limit: 1000 })).data.map(s => s.name);
  assert.deepEqual(names, [...names].sort());
});

test('聯動計數：每組在其他條件下計算，與列表結果一致', async () => {
  const q = { view: 'all', domain: 'INV', owner: '王敏' };
  const f = await facets(q);
  const listed = await list({ ...q, limit: 1 });
  assert.equal(f.total, listed.page.total);
  assert.equal(f.groups.owner['王敏'], f.total, '已選的值等於總數');
  const ord = await list({ view: 'all', domain: 'ORD', owner: '王敏', limit: 1 });
  assert.equal(f.groups.domain.ORD || 0, ord.page.total, '未選的領域顯示「點下去會剩幾個」');
  const lee = await list({ view: 'all', domain: 'INV', owner: '李強', limit: 1 });
  assert.equal(f.groups.owner['李強'] || 0, lee.page.total);
  assert.ok(f.views.all >= 600 && typeof f.views.mine === 'number');
  assert.ok(f.domainLevels.INV.L2 > 0, '領域層級構成');
  const m = await facets({ view: 'all', pivot: 'domain' });
  assert.ok(m.matrix, '矩陣');
});

test('批量整理：計畫、跳過說明、權限、撤銷與「批量之後又被修改」', async () => {
  const tms = (await list({ view: 'all', domain: 'TMS', q: '管理測試', sort: 'id', limit: 6 })).data;
  const ids = tms.map(s => s.id);
  const url = '/api/v1/subjects/batch';
  assert.equal((await consumer('POST', url, { ids, set: { owner: '周婷' } })).status, 403, '消費者不能批量');

  const before = await Promise.all(ids.map(card));
  const plan = await agent('POST', url, { ids, set: { owner: tms[0].owner }, dryRun: true });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.commit, undefined, 'dryRun 不提交');
  assert.ok(plan.body.data.skipped.some(x => x.id === ids[0] && /已經是|本來就沒有/.test(x.reason)), '本來就是目標值的跳過並說明');

  const done = await agent('POST', url, { ids, set: { errorCost: 5 }, addTags: ['批量驗收'] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.commit && done.body.undoable);
  assert.match(done.body.data.message, /\[批量\]/);
  for (const id of ids) {
    const c = await card(id);
    assert.equal(c.subject.errorCost, 5);
    assert.ok(c.subject.tags.includes('批量驗收'));
  }

  // 指定負責人與有效期只有負責人能改：智能體提交時逐個跳過
  const ownerOnly = await agent('POST', url, { ids, set: { expiryDays: 30 }, dryRun: true });
  assert.equal(ownerOnly.body.data.updated.length, 0);
  assert.equal(ownerOnly.body.data.skipped.length, ids.length);

  // 批量之後又改過一個：撤銷時跳過它，其餘還原
  await agent('PATCH', `/api/v1/subjects/${ids[1]}`, { errorCost: 2 });
  const undo = await agent('POST', `${url}/undo`, { commit: done.body.commit });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.ok(undo.body.data.skipped.some(x => x.id === ids[1]), JSON.stringify(undo.body.data.skipped));
  for (const [i, id] of ids.entries()) {
    const c = await card(id);
    if (i === 1) { assert.equal(c.subject.errorCost, 2); continue; }
    assert.equal(c.subject.errorCost, before[i].subject.errorCost);
    assert.deepEqual(c.subject.tags, before[i].subject.tags);
  }
  assert.equal((await agent('POST', `${url}/undo`, { commit: done.body.commit })).status, 409, '不能撤銷兩次');
  assert.equal((await agent('POST', `${url}/undo`, { commit: 'abc123' })).status, 404);

  // 按篩選條件批量：把 PLN 中沒有負責人的主體交給一個人
  const q = { domain: 'PLN', owner: 'none', view: 'all' };
  const n = (await list({ ...q, limit: 1 })).page.total;
  const byQuery = await t.admin('POST', url, { query: q, set: { owner: '周婷' } });
  assert.equal(byQuery.status, 200, JSON.stringify(byQuery.body));
  assert.equal(byQuery.body.data.updated.length, n);
  assert.equal((await list({ ...q, limit: 1 })).page.total, 0);
  const log = (await t.admin('GET', '/admin/api/log?limit=10')).body.data;
  const entry = log.find(l => l.hash && done.body.commit.startsWith(l.hash));
  assert.ok(entry, '變更記錄中可見批量提交');
  assert.deepEqual(entry.batch, { undoable: false, undoneBy: entry.batch.undoneBy });
  assert.ok(entry.batch.undoneBy, '已撤銷的批量在變更記錄中標明');
  assert.equal(log.find(l => byQuery.body.commit.startsWith(l.hash))?.batch?.undoable, true);
});

test('批量校驗與批量確認為 L0（逐條附審閱版本，只限負責人）', async () => {
  const v = await agent('POST', '/api/v1/validate-batch', { subjectIds: ['S-INV-0012'] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.subjects, 1);
  assert.ok(v.body.data.total >= 1);
  assert.equal((await agent('POST', '/api/v1/validate-batch', { subjectIds: [] })).status, 400);

  const s = (await agent('POST', '/api/v1/subjects', { name: '批量確認主體', type: '規則', domain: 'INV' })).body.data;
  for (const content of ['規則甲', '規則乙']) assert.equal((await agent('POST', `/api/v1/subjects/${s.id}/assertions`, { content, type: '規則', evidence: { sourceRef: 'spec' } })).status, 201);
  const c = await agent('POST', '/api/v1/items/confirmable', { subjectIds: [s.id] });
  assert.equal(c.status, 200);
  assert.equal(c.body.data.length, 2);
  const items = c.body.data.map(x => ({ id: x.id, version: x.version }));
  assert.equal((await agent('POST', '/api/v1/items/confirm-batch', { items })).status, 403);
  const ok = await t.admin('POST', '/api/v1/items/confirm-batch', { items, note: '批量核對' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok((await card(s.id)).assertions.every(a => a.validity.level === 'L0'));
  assert.equal((await t.admin('POST', '/api/v1/items/confirm-batch', { items })).status, 409, '版本已變，整批拒絕');
});

test('導出 CSV、查重、導入的查重與錯誤', async () => {
  const csv = await consumer('GET', '/api/v1/subjects/export?domain=INV&view=all');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const total = (await list({ domain: 'INV', view: 'all', limit: 1 })).page.total;
  const lines = csv.body.trim().split(/\r?\n/);
  assert.ok(lines[0].includes('ID'));
  assert.equal(lines.length, total + 1);

  const sim = await consumer('GET', `/api/v1/subjects/similar?${new URLSearchParams({ name: '庫存中' })}`);
  assert.equal(sim.status, 200);
  assert.ok(sim.body.data.some(x => x.id === 'S-INV-0001'));
  assert.equal((await consumer('GET', '/api/v1/subjects/similar')).status, 400);

  const rows = [
    { name: '導入新主體', type: '系統', domain: 'INV', aliases: '導入別名甲、導入別名乙' },
    { name: '庫存中心', type: '系統', domain: 'INV' },
    { name: '導入新主體', type: '系統', domain: 'INV' },
    { name: '類型錯誤', type: '不存在', domain: 'INV' }
  ];
  const dry = await agent('POST', '/api/v1/subjects/import', { rows, dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.data.rows.map(x => x.status), ['create', 'skip', 'error', 'error'], '已存在的跳過，表內重名與類型錯誤報錯');
  assert.equal(dry.body.data.rows[2].reason, '與第 1 行重名', '沒有行號時按 rows 順序從 1 數');
  const lined = await agent('POST', '/api/v1/subjects/import', { rows: rows.map((r, i) => ({ ...r, line: i + 2 })), dryRun: true });
  assert.equal(lined.body.data.rows[2].reason, '與第 2 行重名', '帶表格行號時用表格行號');
  assert.equal(lined.body.data.rows[2].line, 4);
  assert.equal((await list({ q: '導入新主體', view: 'all', limit: 1 })).page.total, 0, 'dryRun 不寫入');
  const done = await agent('POST', '/api/v1/subjects/import', { rows });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.data.created.length, 1);
  assert.equal(done.body.data.created[0].aliases.length, 2);
  assert.equal((await agent('POST', '/api/v1/subjects/import', { rows: rows.slice(1, 2) })).status, 400, '沒有可以新增的行');
});

test('批量新增關係：方向不合規的跳過並說明', async () => {
  const mk = async (name, type) => (await agent('POST', '/api/v1/subjects', { name, type, domain: 'WMS' })).body.data.id;
  const a = await mk('關係批量系統甲', '系統');
  const b = await mk('關係批量系統乙', '系統');
  const p = await mk('關係批量流程', '流程');
  const target = await mk('關係批量目標系統', '系統');
  const body = { subjectIds: [a, b, p], type: '依賴', target, direction: 'out' };
  const dry = await agent('POST', '/api/v1/relations/batch', { ...body, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.data.ok.length, 2);
  assert.deepEqual(dry.body.data.skipped.map(x => x.id), [p]);
  const done = await agent('POST', '/api/v1/relations/batch', body);
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.data.created.length, 2);
  assert.ok(done.body.data.created.every(r => r.to === target && r.level === 'L2'));
  assert.equal((await agent('POST', '/api/v1/relations/batch', { ...body, subjectIds: [p] })).status, 400);
  const rels = await consumer('GET', `/api/v1/relations?subjectId=${a}`);
  assert.ok(rels.body.data.every(r => typeof r.reviewVersion === 'string'), '關係列表帶審閱版本');
});

test('標籤共用：主體標籤進字典，計入主體數；重命名與合併同時改寫主體', async () => {
  const ids = (await list({ view: 'all', domain: 'WMS', q: '管理測試', sort: 'id', limit: 3 })).data.map(s => s.id);
  const r = await agent('POST', '/api/v1/subjects/batch', { ids, addTags: ['倉儲共用標籤'] });
  assert.equal(r.status, 200);
  let tags = (await consumer('GET', '/api/v1/doc-tags')).body.data.tags;
  assert.equal(tags.find(x => x.name === '倉儲共用標籤')?.subjects, 3);
  const ren = await t.admin('PUT', `/api/v1/doc-tags/${encodeURIComponent('倉儲共用標籤')}`, { newName: '倉儲標籤' });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  for (const id of ids) assert.ok((await card(id)).subject.tags.includes('倉儲標籤'));
  const merge = await t.admin('POST', '/api/v1/doc-tags/merge', { from: ['倉儲標籤'], to: '口徑' });
  assert.equal(merge.status, 200, JSON.stringify(merge.body));
  assert.equal(merge.body.data.subjects, 3);
  for (const id of ids) {
    const tg = (await card(id)).subject.tags;
    assert.ok(tg.includes('口徑') && !tg.includes('倉儲標籤'));
  }
  tags = (await consumer('GET', '/api/v1/doc-tags')).body.data.tags;
  assert.ok(!tags.some(x => x.name === '倉儲標籤'));
  const inline = await agent('PATCH', `/api/v1/subjects/${ids[0]}`, { tags: ['口徑', '新加的標籤'] });
  assert.equal(inline.status, 200);
  tags = (await consumer('GET', '/api/v1/doc-tags')).body.data.tags;
  assert.ok(tags.some(x => x.name === '新加的標籤'), '新標籤自動加入字典');
});

test('偏好與我的視圖：按登入身份保存，帶版面；「我負責的」用偏好中的名字', async () => {
  const p = await t.admin('PUT', '/admin/api/prefs', { ownerName: '陳靜', singleKeys: false });
  assert.equal(p.status, 200);
  assert.equal(p.body.data.ownerName, '陳靜');
  const g = await t.admin('GET', '/admin/api/prefs');
  assert.equal(g.body.data.ownerName, '陳靜');
  assert.equal(g.body.data.prefs.singleKeys, false);
  assert.equal((await t.admin('PUT', '/admin/api/prefs', { ownerName: 123 })).status, 400);

  const mine = await t.admin('GET', '/api/v1/subjects?view=mine&limit=1000');
  assert.ok(mine.body.data.length > 0 && mine.body.data.every(s => s.owner === '陳靜'));
  const f = await t.admin('GET', '/api/v1/subjects/facets?view=all');
  assert.equal(f.body.data.views.mine, mine.body.page.total);

  const views = [
    { name: '庫存無負責人', query: 'domain=INV&owner=none', layout: 'cols=id,name,owner&density=standard', default: true },
    { name: '核心標籤', query: 'tag=核心' }
  ];
  const put = await t.admin('PUT', '/admin/api/views', { scope: 'subjects', views });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const got = (await t.admin('GET', '/admin/api/views')).body.data.subjects;
  assert.equal(got.length, 2);
  assert.equal(got[0].layout, views[0].layout);
  assert.equal(got[0].default, true);
  assert.ok(got.every(v => v.id));
  assert.equal((await t.admin('PUT', '/admin/api/views', { scope: 'nope', views: [] })).status, 400);
  assert.equal((await t.admin('PUT', '/admin/api/views', { scope: 'docs', views: [{ name: 'a', query: '', default: true }, { name: 'b', query: '', default: true }] })).status, 400);
  assert.equal((await t.admin('PUT', '/admin/api/views', { scope: 'docs', views: [{ name: '', query: '' }] })).status, 400);
  assert.equal((await t.call('GET', '/admin/api/views')).status, 401);
});

test('OpenAPI 與教程列出新的主體管理接口', async () => {
  const oa = (await t.call('GET', '/api/v1/openapi.json')).body;
  for (const p of ['/subjects/facets', '/subjects/batch', '/subjects/batch/undo', '/subjects/import', '/subjects/export', '/subjects/similar', '/relations/batch', '/validate-batch', '/items/confirmable', '/items/confirm-batch']) assert.ok(oa.paths[p], p);
  const names = oa.paths['/subjects'].get.parameters.map(x => x.name);
  for (const n of ['state', 'owner', 'tag', 'view', 'sort', 'offset', 'limit']) assert.ok(names.includes(n), n);
  const prompt = (await t.call('GET', '/api/v1/prompt')).body;
  assert.ok(prompt.includes('/subjects/similar') && prompt.includes('/subjects/batch'));
});

test('性能：5000 個主體時篩選、排序和聯動計數都在 100 ms 內', async () => {
  const { store } = await makeStore();
  await store.tx(ADMIN, '準備', tx => store.createSubject(tx, { name: '性能樣本', type: '系統', domain: 'INV', owner: '王敏', definition: '樣本' }, ADMIN));
  const sample = [...store.subjects.values()].find(s => s.name === '性能樣本');
  for (let i = 0; i < 5000; i++) {
    const s = structuredClone(sample);
    s.id = `S-PRF-${String(i).padStart(5, '0')}`;
    s.name = `性能主體 ${i}`;
    s.domain = DOMAINS[i % DOMAINS.length];
    s.type = TYPES[i % TYPES.length];
    s.owner = OWNERS[i % OWNERS.length];
    s.tags = TAGS.filter((_, k) => (i + k) % 3 === 0);
    s.definition = i % 4 ? s.definition : '';
    store.subjects.set(s.id, s);
  }
  store.gen++;
  const opts = { me: '王敏' };
  store.querySubjects({ view: 'all' }, opts); // 建立派生索引（寫入後第一次查詢）
  const time = fn => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  const cases = [
    () => store.querySubjects({ view: 'all', domain: 'INV,ORD', owner: '!none', sort: '-priority', limit: 100 }, opts),
    () => store.querySubjects({ view: 'all', q: '性能主體 12', tag: '口徑', sort: 'name' }, opts),
    () => store.subjectFacets({ view: 'all', domain: 'TMS', state: 'no_definition' }, opts),
    () => store.subjectFacets({ view: 'all', pivot: 'domain' }, opts)
  ];
  for (const fn of cases) {
    const ms = Math.min(time(fn), time(fn), time(fn));
    assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  }
  assert.ok(store.querySubjects({ view: 'all', limit: 1 }, opts).total >= 5000);
});
