import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, ADMIN } from './helpers.js';

test('切換知識目錄後，變更記錄與最近提交只顯示當前目錄；先篩選再限制數量', async t => {
  const s = await startServer();
  t.after(() => s.close());
  const switchTo = async subdir => {
    const r = await s.admin('PUT', '/admin/api/settings/git', { subdir });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const createSubject = async name => {
    const r = await s.admin('POST', '/api/v1/subjects', { name, type: '指標', domain: 'INV' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.id;
  };
  const testSubject = await createSubject('測試目錄專用指標');
  const repo = s.srv.ctx.store.repo;
  await switchTo('knowledge-prod-v01');
  assert.equal(s.srv.ctx.store.repo.dir, repo.dir, '兩個知識目錄共用同一 Git 倉庫');
  const prodSubject = await createSubject('正式目錄專用指標');

  // 一次提交同時修改兩個目錄，應在兩邊都能看到。
  for (const dir of ['knowledge', 'knowledge-prod-v01']) await fs.appendFile(path.join(repo.dir, dir, 'README.md'), '\n共用變更。\n');
  const shared = await repo.commit('同時更新兩個知識目錄', { paths: ['knowledge', 'knowledge-prod-v01'] });
  assert.ok(shared);
  // 後續大量正式目錄提交，不應擠掉測試目錄的最近提交。
  const store = s.srv.ctx.store;
  for (let i = 0; i < 10; i++) await store.tx(ADMIN, `正式目錄更新 ${i}`, tx => store.updateSubject(tx, prodSubject, { definition: `版本 ${i}` }, ADMIN));
  await fs.writeFile(path.join(repo.dir, 'outside.txt'), '不屬於任何知識目錄\n');
  await repo.commit('倉庫根目錄變更', { paths: ['outside.txt'] });

  const verify = async (subdir, included, excluded) => {
    await switchTo(subdir);
    const log = await s.admin('GET', '/admin/api/log?limit=200');
    const overview = await s.admin('GET', '/admin/api/overview');
    assert.equal(log.status, 200);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.data.git.subdir, subdir);
    for (const rows of [log.body.data, overview.body.data.log]) {
      assert.ok(rows.length > 0);
      assert.ok(!rows.some(row => row.subject.includes(excluded)));
      assert.ok(!rows.some(row => row.subject === '倉庫根目錄變更'));
    }
    assert.ok(log.body.data.some(row => row.subject.includes(included)));
    assert.ok(log.body.data.some(row => row.hash === shared));
    return { log: log.body.data, overview: overview.body.data };
  };
  const testing = await verify('knowledge', '測試目錄專用指標', '正式目錄');
  assert.equal(testing.overview.log[0].hash, shared);
  const limited = await s.admin('GET', '/admin/api/log?limit=1');
  assert.equal(limited.body.data.length, 1);
  assert.equal(limited.body.data[0].hash, shared);
  const history = await s.admin('GET', `/api/v1/subjects/${testSubject}/history`);
  assert.equal(history.status, 200);
  assert.ok(history.body.data.some(row => row.subject.includes('測試目錄專用指標')));
  assert.ok(!history.body.data.some(row => row.subject.includes('正式目錄')));
  await verify('knowledge-prod-v01', '正式目錄專用指標', '測試目錄專用指標');
});

test('知識目錄名稱按字面匹配，不把 Git 通配符當成跨目錄查詢', async t => {
  const s = await startServer();
  t.after(() => s.close());
  for (const [subdir, label] of [['knowledge[1]', '含方括號的目錄'], ['knowledge1', '另一個目錄']]) {
    const r = await s.admin('PUT', '/admin/api/settings/git', { subdir });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await s.srv.ctx.store.tx(ADMIN, label, tx => tx.writeRaw('docs/通用/nested.md', `# ${label}\n`));
  }
  assert.equal((await s.admin('PUT', '/admin/api/settings/git', { subdir: 'knowledge[1]' })).status, 200);
  const r = await s.admin('GET', '/admin/api/log');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some(row => row.subject === '含方括號的目錄'));
  assert.ok(!r.body.data.some(row => row.subject === '另一個目錄'));
});
