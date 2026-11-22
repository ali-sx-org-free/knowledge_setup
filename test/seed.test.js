import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN } from './helpers.js';

test('舊版示例補齊文檔：沿用實際 ID、保留已有內容，重複載入不新增或覆蓋', async t => {
  const s = await startServer();
  t.after(() => s.close());
  const store = s.srv.ctx.store;
  // 先有其他資料，確保補齊時不能假設 S-INV-0012 / O-0001 / A-0003。
  await store.tx(ADMIN, '既有資料', tx => {
    const subject = store.createSubject(tx, { name: '既有指標', type: '指標', domain: 'INV', definition: '保留' }, ADMIN);
    store.createAssertion(tx, subject.id, { type: '定義', content: '保留既有斷言' }, ADMIN);
    store.createObject(tx, { name: '既有制度', category: '制度', kind: '口徑定義', locator: 'wiki://existing' }, ADMIN);
  });
  const fresh = await s.admin('POST', '/admin/api/seed');
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.equal(fresh.body.data.subjects, 26);
  assert.equal(fresh.body.data.docsAdded, 3);
  const focus = fresh.body.data.focus;
  assert.notEqual(focus, 'S-INV-0012');
  // 僅在臨時測試倉庫回到文檔庫引入之前的資料狀態。
  const legacy = (await store.repo.git(['log', '-1', '--format=%H', '--fixed-strings', '--grep=[示例] 負責人確認高頻、高風險知識'])).trim();
  assert.match(legacy, /^[a-f0-9]{40}$/);
  await store.repo.git(['reset', '--hard', legacy]);
  await store.load();
  assert.equal(store.docs.docs.size, 0);
  let ownDoc;
  await store.tx(ADMIN, '保留使用者修改', tx => {
    store.updateSubject(tx, focus, { owner: '實際負責人' }, ADMIN);
    store.docs.createFolder(tx, { path: '庫存', description: '自訂文件夾說明' }, ADMIN);
    store.docs.updateTag(tx, '口徑', { color: 'red', description: '自訂標籤說明' }, ADMIN);
    ownDoc = store.docs.create(tx, { template: 'TPL-0001', title: '我的草稿', body: '## 概述\n\n保留我的草稿。' }, ADMIN).id;
  });
  const subjectsBefore = structuredClone([...store.subjects]);
  const relationsBefore = structuredClone([...store.relations]);
  const actionsBefore = structuredClone([...store.actions]);
  const ownDocBefore = structuredClone(store.docs.get(ownDoc));
  const objectsBefore = structuredClone([...store.objects]);
  const docObject = [...store.objects.values()].find(o => o.locator === 'wiki://inventory/metrics/v3');

  const upgraded = await s.admin('POST', '/admin/api/seed');
  assert.equal(upgraded.status, 201, JSON.stringify(upgraded.body));
  assert.equal(upgraded.body.data.subjects, 0);
  assert.equal(upgraded.body.data.docsAdded, 3);
  assert.equal(upgraded.body.data.focus, focus);
  assert.deepEqual([...store.subjects], subjectsBefore);
  assert.deepEqual([...store.relations], relationsBefore);
  for (const [id, action] of actionsBefore) assert.deepEqual(store.actions.get(id), action);
  // 第二期首次發布會補上內置的文檔校驗 Action，原有 Action 仍必須完整保留。
  const existingActionIds = new Set(actionsBefore.map(([id]) => id));
  const addedActions = [...store.actions.values()].filter(action => !existingActionIds.has(action.id));
  assert.equal(addedActions.length, 1);
  assert.equal(addedActions[0].builtin, true);
  assert.equal(addedActions[0].name, '文檔已發布');
  assert.equal(store.pipelines.get(addedActions[0].pipelineId).type, 'docs');
  assert.ok(store.objects.get(docObject.id).actionIds.includes(addedActions[0].id));
  assert.deepEqual(store.docs.get(ownDoc), ownDocBefore);
  assert.equal(store.docs.tags['口徑'].color, 'red');
  assert.equal(store.docs.folders.get('庫存').description, '自訂文件夾說明');
  for (const [id, obj] of objectsBefore) if (id !== docObject.id) assert.deepEqual(store.objects.get(id), obj);

  const ids = upgraded.body.data.docs;
  const metricsId = Object.keys(ids).find(id => ids[id] === '庫存口徑定義');
  const sopId = Object.keys(ids).find(id => ids[id] === '跨倉調撥作業 SOP');
  assert.notEqual(metricsId, ownDoc);
  const metrics = (await s.admin('GET', `/api/v1/docs/${metricsId}`)).body.data;
  assert.equal(metrics.version, 4);
  assert.equal(metrics.objectId, docObject.id);
  assert.equal(metrics.fields.metric, focus);
  assert.ok(!Object.values(metrics.refs).some(ref => ref.state === 'missing'));
  assert.equal(store.docs.statusOf(store.docs.get(sopId)), '草稿');
  const history = await s.admin('GET', `/api/v1/docs/${metricsId}/history`);
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(history.body), /"version":3/);
  assert.match(JSON.stringify(history.body), /"version":4/);

  const before = structuredClone([...store.docs.docs]);
  const head = (await store.repo.git(['rev-parse', 'HEAD'])).trim();
  const again = await s.admin('POST', '/admin/api/seed');
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.data.docsAdded, 0);
  assert.deepEqual([...store.docs.docs], before);
  assert.equal((await store.repo.git(['rev-parse', 'HEAD'])).trim(), head);

  // 只有一篇缺失時也只補這一篇，已發布版本及自己的草稿不動。
  assert.equal((await s.admin('DELETE', `/api/v1/docs/${sopId}/draft`)).status, 200);
  const partial = await s.admin('POST', '/admin/api/seed');
  assert.equal(partial.status, 201, JSON.stringify(partial.body));
  assert.equal(partial.body.data.docsAdded, 1);
  assert.deepEqual(store.docs.get(metricsId), before.find(([id]) => id === metricsId)[1]);
  assert.deepEqual(store.docs.get(ownDoc), ownDocBefore);
});

test('同名主體不足以接管：缺失舊示例依據時不寫入任何示例資料', async t => {
  const s = await startServer();
  t.after(() => s.close());
  const store = s.srv.ctx.store;
  await store.tx(ADMIN, '使用者自己的指標', tx => store.createSubject(tx, { name: '可售庫存', type: '指標', domain: 'INV', definition: '自訂定義' }, ADMIN));
  const head = (await store.repo.git(['rev-parse', 'HEAD'])).trim();
  const r = await s.admin('POST', '/admin/api/seed');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'seed_dependencies_missing');
  assert.equal(store.subjects.size, 1);
  assert.equal(store.docs.docs.size, 0);
  assert.equal(store.objects.size, 0);
  assert.equal((await store.repo.git(['rev-parse', 'HEAD'])).trim(), head);
});
