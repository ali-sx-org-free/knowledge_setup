// 文檔庫（設計文件 §17）：生命週期與權限、修訂可見性、小修與重大修訂、歷史與差異、草稿衝突、整理（文件夾、標籤）、
// 體檢規則、接管與廢止、Git 直接修改與待登記、段級搜索、圖片、gitWebUrl、Markdown 渲染的安全性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, makeStore, ADMIN, AGENT, OWNER } from './helpers.js';
import { gitWebUrl } from '../src/api/docs.js';
import { docHistory } from '../src/services/doc-history.js';
import { renderMarkdown, safeHref, parseSections, extractRefs } from '../web/assets/markdown.js';

const KB_BODY = `## 概述

可售庫存是可以下單佔用的庫存。

## 詳細說明

見 [[S-INV-0012]]，按 SKU + 倉庫計算。
`;

/** 管理員登入，返回 cookie（用於需要自訂請求頭的調用）。 */
async function login(s) {
  const r = await fetch(`${s.base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-pass' }) });
  return r.headers.get('set-cookie').split(';')[0];
}

/** 啟動並載入庫存域示例（含 DOC-0001～0003）。 */
async function seeded() {
  const s = await startServer();
  const r = await s.admin('POST', '/admin/api/seed');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return s;
}

test('生命週期與權限：智能體建草稿、不能發布；人按模板規則發布；讀者看不到從未發布的草稿', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const agent = await s.keyFor('agent', 'contributor');
  const human = await s.keyFor('human', 'contributor');
  const reader = await s.keyFor('agent', 'consumer');

  // 疑似機密拒絕保存
  const leak = await agent('POST', '/api/v1/docs', { template: 'TPL-0001', title: '帶機密的文檔', body: `## 概述\n\ntoken: ghp_${'a1'.repeat(20)}\n` });
  assert.equal(leak.status, 422);
  assert.equal(leak.body.error.code, 'secret_detected');

  const created = await agent('POST', '/api/v1/docs', { template: 'TPL-0001', title: '可售庫存是什麼', folder: '庫存', body: KB_BODY, fields: { topic: ['S-INV-0012'] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.match(id, /^DOC-\d{4}$/);
  assert.equal(created.body.data.status, '草稿');
  assert.ok(Array.isArray(created.body.problems));
  assert.ok(created.body.data.subjects.includes('S-INV-0012'), '關聯類欄位自動加入關聯主體');

  // 讀者：從未發布的草稿不可見，也讀不到草稿
  assert.equal((await reader('GET', `/api/v1/docs/${id}`)).status, 404);
  assert.equal((await reader('GET', `/api/v1/docs/${id}?draft=1`)).status, 403);
  assert.ok(!(await reader('GET', '/api/v1/docs')).body.data.some(d => d.id === id));

  // 智能體不能發布；提交審閱要先通過體檢（缺摘要）
  const pub = await agent('POST', `/api/v1/docs/${id}/publish`, {});
  assert.equal(pub.status, 403);
  assert.equal(pub.body.error.code, 'agent_cannot_publish');
  const sub1 = await agent('POST', `/api/v1/docs/${id}/submit`);
  assert.equal(sub1.status, 422);
  assert.equal(sub1.body.error.code, 'lint_failed');
  assert.ok(sub1.body.error.problems.some(p => p.rule === 'D2' && p.level === 'error'));
  const etag = (await agent('GET', `/api/v1/docs/${id}?draft=1`)).body.data.etag;
  assert.equal((await agent('PUT', `/api/v1/docs/${id}/draft`, { etag, summary: '可售庫存的定義與計算口徑。' })).status, 200);
  const sub2 = await agent('POST', `/api/v1/docs/${id}/submit`);
  assert.equal(sub2.status, 200, JSON.stringify(sub2.body));
  assert.equal(sub2.body.data.status, '待審');

  // 知識條目：人類貢獻者可以直接發布；首次發布登記制度客體
  const done = await human('POST', `/api/v1/docs/${id}/publish`, { note: '第一版' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.version, 1);
  assert.equal(done.body.data.registered, true);
  const obj = (await s.admin('GET', `/api/v1/objects/${done.body.data.objectId}`)).body.data;
  assert.equal(obj.category, '制度');
  assert.equal(obj.locator, `doc://${id}`);
  assert.equal(obj.docId, id);
  const read = await reader('GET', `/api/v1/docs/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.status, '已發布');
  assert.match(read.body.data.git.file, new RegExp(`^knowledge/docs/庫存/${id}-`));

  // SOP 要負責人審閱：人類貢獻者不能直接發布
  const sop = await human('POST', '/api/v1/docs', { template: 'TPL-0003', title: '盤點作業 SOP', folder: '庫存/SOP' });
  assert.equal(sop.status, 201);
  const denied = await human('POST', `/api/v1/docs/${sop.body.data.id}/publish`, {});
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'approval_required');

  // 文件夾只有人可以建；刪除草稿限建立者或負責人
  assert.equal((await agent('POST', '/api/v1/doc-folders', { path: '新文件夾' })).status, 403);
  assert.equal((await agent('DELETE', `/api/v1/docs/${sop.body.data.id}/draft`)).status, 403);
  assert.equal((await human('DELETE', `/api/v1/docs/${sop.body.data.id}/draft`)).status, 200);
  // 刪除已發布文檔只限管理員
  assert.equal((await human('DELETE', `/api/v1/docs/${id}`)).status, 403);
});

test('修訂：讀者看已發布版本，draft=1 看修訂；草稿衝突返回 409 與對方內容；小修不降級、重大修訂按勾選降級並記錄', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const human = await s.keyFor('human', 'contributor');
  const reader = await s.keyFor('agent', 'consumer');

  const pub = (await reader('GET', '/api/v1/docs/DOC-0001')).body.data;
  assert.equal(pub.version, 4, '示例：從 v3 接管，v4 小修');
  const body = `${pub.body.trimEnd()}\n\n補充：調撥在途的數量由運輸系統維護。\n`;
  assert.equal((await s.admin('GET', '/api/v1/docs/DOC-0001?draft=1')).status, 404, '還沒有修訂');
  const etag = pub.etag;
  const saved = await s.admin('PUT', '/api/v1/docs/DOC-0001/draft', { etag, body });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  // 讀者仍看到 v4；貢獻者用 draft=1 看到修訂
  const again = (await reader('GET', '/api/v1/docs/DOC-0001')).body.data;
  assert.equal(again.version, 4);
  assert.ok(!again.body.includes('補充：調撥在途'));
  const draft = (await human('GET', '/api/v1/docs/DOC-0001?draft=1')).body.data;
  assert.ok(draft.body.includes('補充：調撥在途'));
  assert.equal(draft.revision, '修訂中');

  // 用舊 etag 再保存：409，帶上對方的內容
  const stale = await human('PUT', '/api/v1/docs/DOC-0001/draft', { etag, body: `${body}再改一句。\n` });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'draft_conflict');
  assert.ok(stale.body.error.current.body.includes('補充：調撥在途'));
  assert.ok(stale.body.error.current.etag);

  // 口徑定義要負責人審閱：人類貢獻者不能發布
  assert.equal((await human('POST', '/api/v1/docs/DOC-0001/publish', {})).status, 403);

  // 影響範圍：以本文檔為依據的知識
  const impact = (await s.admin('GET', '/api/v1/docs/DOC-0001/impact')).body.data;
  assert.equal(impact.objectId, 'O-0001');
  assert.equal(impact.items.length, 12);
  const l0 = impact.items.filter(x => x.level === 'L0');
  assert.ok(l0.length > 0);

  // 不在影響範圍內的條目不能勾選
  const badAffect = await s.admin('POST', '/api/v1/docs/DOC-0001/publish', { major: true, affect: ['A-0002'] });
  assert.equal(badAffect.status, 400);
  assert.equal(badAffect.body.error.code, 'invalid_affect');

  // 小修：不降級
  const minor = await s.admin('POST', '/api/v1/docs/DOC-0001/publish', { major: false, note: '補一句說明' });
  assert.equal(minor.status, 200, JSON.stringify(minor.body));
  assert.equal(minor.body.data.version, 5);
  assert.equal(minor.body.data.demoted, 0);
  for (const x of l0) assert.equal((await s.admin('GET', `/api/v1/items/${x.id}`)).body.data.validity.level, 'L0');

  // 重大修訂：勾選的 L0 降為 L1 並排入重驗，備註帶文檔與版本
  const etag2 = (await s.admin('GET', '/api/v1/docs/DOC-0001')).body.data.etag;
  await s.admin('PUT', '/api/v1/docs/DOC-0001/draft', { etag: etag2, body: body.replace('安全庫存', '安全庫存（含在途保留）') });
  const target = l0[0];
  const major = await s.admin('POST', '/api/v1/docs/DOC-0001/publish', { major: true, note: '口徑調整', affect: [target.id] });
  assert.equal(major.status, 200, JSON.stringify(major.body));
  assert.equal(major.body.data.version, 6);
  assert.equal(major.body.data.demoted, 1);
  const item = (await s.admin('GET', `/api/v1/items/${target.id}`)).body.data;
  assert.equal(item.validity.level, 'L1');
  assert.equal(item.validity.pending.reason, 'object_changed');
  assert.ok(item.validity.history.some(h => h.note === 'DOC-0001 v6 重大修訂：口徑調整'), JSON.stringify(item.validity.history));
  const queue = (await s.admin('GET', '/api/v1/queue')).body.data;
  assert.ok(queue.some(q => q.id === target.id));

  // 歷史與差異
  const hist = (await s.admin('GET', '/api/v1/docs/DOC-0001/history')).body.data;
  assert.deepEqual(hist.versions.map(v => v.version), [6, 5, 4, 3]);
  assert.equal(hist.versions[0].major, true);
  const diff = (await s.admin('GET', '/api/v1/docs/DOC-0001/diff?from=5&to=6')).body.data;
  assert.ok(diff.hunks.some(h => h.lines.some(l => l.op === '+' && l.text.includes('含在途保留'))));
  assert.ok(diff.sections.some(x => x.change === 'modified'));
  assert.equal(diff.meta.length, 0, '空值不算變化');
  // 不帶 from：與上一個版本比較；接管的第一個版本（v3）沒有更早的版本
  const d4 = (await s.admin('GET', '/api/v1/docs/DOC-0001/diff?to=4')).body.data;
  assert.equal(d4.from.version, 3);
  const d3 = await s.admin('GET', '/api/v1/docs/DOC-0001/diff?to=3');
  assert.equal(d3.status, 200);
  assert.equal(d3.body.data.stats.added + d3.body.data.stats.removed, 0);
  const old = (await reader('GET', '/api/v1/docs/DOC-0001?version=3')).body.data;
  assert.equal(old.version, 3);
  assert.ok(!old.body.includes('跨倉調撥'), 'v3 沒有 v4 補充的示例');
  assert.equal((await reader('GET', '/api/v1/docs/DOC-0001/diff?from=3&to=4')).status, 403, '差異需要 contributor');
});

test('不可修訂的模板、順手綁定、確認複審、廢止級聯', async t => {
  const s = await seeded();
  t.after(() => s.close());

  // 評審記錄：發布後不能修訂
  const rec = await s.admin('POST', '/api/v1/docs', {
    template: 'TPL-0006', title: '庫存口徑評審 2026-11', summary: '庫存口徑 v4 的評審結論。', owner: '庫存域架構師', subjects: ['S-INV-0012'],
    fields: { target: 'DOC-0001', reviewedOn: '2026-11-20', participants: '庫存域架構師、訂單域架構師', verdict: '通過' },
    body: '## 評審內容\n\n評審 [[DOC-0001]] v4。\n\n## 結論\n\n通過。\n'
  });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  const recId = rec.body.data.id;
  const lint = await s.admin('POST', '/api/v1/docs/lint', { id: recId });
  const pubRec = await s.admin('POST', `/api/v1/docs/${recId}/publish`, {});
  assert.equal(pubRec.status, 200, JSON.stringify({ pub: pubRec.body, lint: lint.body }));
  const etag = (await s.admin('GET', `/api/v1/docs/${recId}`)).body.data.etag;
  const revise = await s.admin('PUT', `/api/v1/docs/${recId}/draft`, { etag, body: '## 評審內容\n\n改了\n' });
  assert.equal(revise.status, 409);
  assert.equal(revise.body.error.code, 'immutable_doc');

  // 首次發布時順手綁定主體（L1）
  const kb = await s.admin('POST', '/api/v1/docs', { template: 'TPL-0001', title: '已預佔庫存說明', folder: '庫存', summary: '已預佔庫存是什麼。', subjects: ['S-INV-0008'], body: '## 概述\n\n已被訂單佔用、尚未出庫的數量。\n\n## 詳細說明\n\n見 [[S-INV-0008]]。\n' });
  const kbId = kb.body.data.id;
  const bound = await s.admin('POST', `/api/v1/docs/${kbId}/publish`, { bindSubjects: ['S-INV-0008'] });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  assert.equal(bound.body.data.bound.length, 1);
  assert.equal(bound.body.data.bound[0].level, 'L1');
  const subj = (await s.admin('GET', '/api/v1/subjects/S-INV-0008')).body.data;
  const b = subj.bindings.find(x => x.object.id === bound.body.data.objectId);
  assert.equal(b.note, `文檔 ${kbId} 發布時綁定`);
  const card = (await s.admin('GET', '/api/v1/subjects/S-INV-0008')).body.data;
  assert.ok(JSON.stringify(card).includes(kbId), '知識卡列出相關文檔');

  // 確認複審：不改版本號，順延下次複審
  const rv = await s.admin('POST', '/api/v1/docs/DOC-0001/review', {});
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  assert.ok(rv.body.data.review.nextAt > new Date().toISOString().slice(0, 10));
  assert.equal((await s.admin('GET', '/api/v1/docs/DOC-0001')).body.data.version, 4);

  // 廢止：客體下線，綁定轉 E1，以它為證據的知識降為 L1；文檔不能再修改
  const agent = await s.keyFor('agent', 'contributor');
  assert.equal((await agent('POST', '/api/v1/docs/DOC-0001/obsolete', { reason: '測試' })).status, 403);
  assert.equal((await s.admin('POST', '/api/v1/docs/DOC-0001/obsolete', {})).status, 400, '廢止要填原因');
  const ob = await s.admin('POST', '/api/v1/docs/DOC-0001/obsolete', { reason: '口徑改由新文檔維護', replacedBy: kbId });
  assert.equal(ob.status, 200, JSON.stringify(ob.body));
  const o1 = (await s.admin('GET', '/api/v1/objects/O-0001')).body.data;
  assert.equal(o1.status, '下線');
  const s12 = (await s.admin('GET', '/api/v1/subjects/S-INV-0012')).body.data;
  const b1 = s12.bindings.find(x => x.object.id === 'O-0001');
  assert.equal(b1.level, 'E1');
  const d1 = (await s.admin('GET', '/api/v1/docs/DOC-0001')).body.data;
  assert.equal(d1.status, '已廢止');
  assert.equal(d1.replacedBy, kbId);
  assert.equal((await s.admin('PUT', '/api/v1/docs/DOC-0001/draft', { body: 'x' })).status, 409);
  // 預設列表不含已廢止
  assert.ok(!(await s.admin('GET', '/api/v1/docs')).body.data.some(d => d.id === 'DOC-0001'));
  assert.ok((await s.admin('GET', '/api/v1/docs?status=已廢止')).body.data.some(d => d.id === 'DOC-0001'));
});

test('接管已有客體：不改定位、版本從起始版本算；同一客體不能被兩篇文檔接管', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const o = await s.admin('POST', '/api/v1/objects', { name: '《缺貨率口徑》', category: '制度', kind: '口徑定義', locator: 'wiki://inventory/stockout' });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const oid = o.body.data.id;
  const field = await s.admin('POST', '/api/v1/docs', { template: 'TPL-0001', title: '接管欄位客體', takeOverObjectId: 'O-0002' });
  assert.equal(field.status, 422, '只能接管制度類客體');
  const d = await s.admin('POST', '/api/v1/docs', { template: 'TPL-0001', title: '缺貨率口徑', folder: '庫存', summary: '缺貨率怎麼算。', subjects: ['S-INV-0015'], takeOverObjectId: oid, startVersion: 7, body: '## 概述\n\n缺貨率。\n\n## 詳細說明\n\n見 [[S-INV-0015]]。\n' });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const dup = await s.admin('POST', '/api/v1/docs', { template: 'TPL-0001', title: '另一篇', takeOverObjectId: oid });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'object_managed_by_doc');
  const p = await s.admin('POST', `/api/v1/docs/${d.body.data.id}/publish`, {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.data.version, 7);
  assert.equal(p.body.data.tookOver, true);
  const obj = (await s.admin('GET', `/api/v1/objects/${oid}`)).body.data;
  assert.equal(obj.locator, 'wiki://inventory/stockout', '接管不改定位');
  assert.equal(obj.docId, d.body.data.id);
  // 由文檔庫管理的客體不能直接下線
  const off = await s.admin('PATCH', `/api/v1/objects/${oid}`, { status: '下線', reason: 'x' });
  assert.equal(off.status, 409, JSON.stringify(off.body));
  assert.equal(off.body.error.code, 'object_managed_by_doc');
});

test('整理：移動、文件夾重命名帶走文檔、標籤重命名與合併改寫文檔，舊名繼續可篩選；批量操作一次提交', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const agent = await s.keyFor('agent', 'contributor');
  // 智能體不能移動文檔
  assert.equal((await agent('PATCH', '/api/v1/docs/DOC-0003', { folder: '庫存' })).status, 403);
  const mv = await s.admin('PATCH', '/api/v1/docs/DOC-0003', { folder: '庫存' });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.deepEqual(mv.body.data.changes.moved, { from: '通用', to: '庫存' });
  const d3 = (await s.admin('GET', '/api/v1/docs/DOC-0003')).body.data;
  assert.equal(d3.version, 1, '移動不改版本');
  assert.match(d3.path, /^docs\/庫存\/DOC-0003-/);

  // 文件夾重命名：裡面的文檔一起移動，一次提交
  const before = (await s.admin('GET', '/admin/api/changes')).body.data?.length;
  const rn = await s.admin('PATCH', '/api/v1/doc-folders', { path: '庫存/口徑', newPath: '庫存/指標口徑' });
  assert.equal(rn.status, 200, JSON.stringify(rn.body));
  const d1 = (await s.admin('GET', '/api/v1/docs/DOC-0001')).body.data;
  assert.match(d1.path, /^docs\/庫存\/指標口徑\/DOC-0001-/);
  const file = path.join(s.srv.ctx.store.root, d1.path);
  await fs.access(file);
  const after = (await s.admin('GET', '/admin/api/changes')).body.data?.length;
  if (before !== undefined && after !== undefined) assert.equal(after, before + 1);
  assert.equal((await s.admin('PATCH', '/api/v1/doc-folders', { path: '庫存', newPath: '庫存/指標口徑/子' })).status, 400, '不能移到自己的子文件夾');
  assert.equal((await s.admin('DELETE', '/api/v1/doc-folders?path=庫存')).status, 409, '只能刪空文件夾');

  // 標籤重命名：改寫文檔；舊名繼續可篩選
  const ren = await s.admin('PUT', `/api/v1/doc-tags/${encodeURIComponent('口徑')}`, { newName: '指標口徑' });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  assert.equal(ren.body.data.renamed.docs, 1);
  assert.deepEqual((await s.admin('GET', '/api/v1/docs/DOC-0001')).body.data.tags.sort(), ['對外', '指標口徑'].sort());
  assert.ok((await s.admin('GET', `/api/v1/docs?tag=${encodeURIComponent('口徑')}`)).body.data.some(d => d.id === 'DOC-0001'), '舊名繼續可用');

  // 合併
  const mg = await s.admin('POST', '/api/v1/doc-tags/merge', { from: ['對外'], to: '指標口徑' });
  assert.equal(mg.status, 200, JSON.stringify(mg.body));
  assert.deepEqual((await s.admin('GET', '/api/v1/docs/DOC-0001')).body.data.tags, ['指標口徑']);
  const tags = (await s.admin('GET', '/api/v1/doc-tags')).body.data;
  assert.equal(tags.merged['對外'], '指標口徑');
  assert.equal(tags.merged['口徑'], '指標口徑');
  assert.equal((await agent('POST', '/api/v1/doc-tags/merge', { from: ['SOP'], to: '指南' })).status, 403, '合併標籤限負責人');

  // 批量加標籤
  const bulk = await s.admin('POST', '/api/v1/docs/bulk', { ids: ['DOC-0001', 'DOC-0003'], addTags: ['試點'] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal(bulk.body.data.changed, 2);
  assert.ok((await s.admin('GET', '/api/v1/docs/DOC-0003')).body.data.tags.includes('試點'));
});

test('搜索：別名解析為規範主體、段級命中帶錨點與引用寫法；JSONL 導出按章節', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const reader = await s.keyFor('agent', 'consumer');
  const list = (await reader('GET', `/api/v1/docs?q=${encodeURIComponent('ATP 口徑')}`)).body;
  assert.equal(list.data[0].id, 'DOC-0001');
  assert.ok(JSON.stringify(list.resolved).includes('S-INV-0012'), JSON.stringify(list.resolved));
  const sec = (await reader('GET', `/api/v1/doc-sections?q=${encodeURIComponent('ATP 口徑')}`)).body.data;
  const hit = sec.find(h => h.docId === 'DOC-0001');
  assert.ok(hit, JSON.stringify(sec).slice(0, 300));
  assert.equal(hit.heading, '計算公式');
  assert.match(hit.cite, /^〔DOC-0001§計算公式·v4〕$/);
  const secs = (await reader('GET', '/api/v1/docs/DOC-0001/sections')).body.data.sections;
  assert.ok(secs.some(x => x.heading === '計算公式' && x.refs.includes('S-INV-0007')));
  const exp = await fetch(`${s.base}/api/v1/docs/export`, { headers: { cookie: '' } });
  assert.equal(exp.status, 401);
  const res = await s.admin('GET', '/api/v1/docs/export');
  const lines = String(res.body).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.docId === 'DOC-0001' && l.anchor && l.cite.startsWith('〔DOC-0001§')));
  assert.ok(!lines.some(l => l.docId === 'DOC-0002'), '導出不含草稿');
});

test('體檢規則：標題、章節、模板提示、引用、提到未關聯的主體、動態值、相對時間、機密；回應按請求語言', async () => {
  const s = await seeded();
  try {
    const body = [
      '# 大標題',
      '## 概述',
      '<!-- 提示：兩三句話說清是什麼 -->',
      '## 詳細說明',
      '目前可售庫存有 120 件，見 [[A-0004]] 和 [[A-9999]]，可售庫存按 SKU 計算。',
      '[[DOC-0001#不存在的章節]]'
    ].join('\n');
    const r = await s.admin('POST', '/api/v1/docs/lint', { template: 'TPL-0001', title: '說明', body, phase: 'publish' });
    const rules = new Map();
    for (const p of r.body.data) rules.set(`${p.rule}:${p.level}`, p);
    const has = (rule, level) => assert.ok(rules.has(`${rule}:${level}`), `${rule}:${level} ${JSON.stringify(r.body.data.map(p => `${p.rule}:${p.level} ${p.message}`))}`);
    has('D1', 'warning'); // 標題過於籠統
    has('D2', 'error'); // 發布前要摘要
    has('D3', 'warning'); // 一級標題
    has('D5', 'error'); // 必填章節只有模板提示
    has('D6', 'error'); // 引用不存在
    has('D6', 'warning'); // 引用 E1 或不存在的錨點
    has('D7', 'info'); // 提到未關聯的主體
    has('D8', 'warning'); // 動態值旁寫數字
    has('D9', 'info'); // 相對時間
    has('D11', 'warning'); // 沒有關聯
    const secret = await s.admin('POST', '/api/v1/docs/lint', { template: 'TPL-0001', title: '連線', body: '## 概述\n\npostgres://app:s3cretPass@db.internal/kb\n' });
    assert.ok(secret.body.data.some(p => p.rule === 'D10' && p.level === 'error'));
    assert.ok(!JSON.stringify(secret.body).includes('s3cretPass'), '體檢結果不回顯機密');
    // 英文請求返回英文訊息
    const en = await s.call('POST', '/api/v1/docs/lint', { template: 'TPL-0001', title: 'x', body: '## 概述\n\nx\n' }, { cookie: await login(s), 'accept-language': 'en' });
    assert.equal(en.status, 200);
    assert.ok(en.body.data.some(p => p.rule === 'D2' && /summary/i.test(p.message)), JSON.stringify(en.body.data));
  } finally {
    s.close();
  }
});

test('Git 中直接修改、待登記檔案、重複 ID：重新載入後如實呈現', async () => {
  const { store } = await makeStore();
  const lib = store.docs;
  const { result: subj } = await store.tx(ADMIN, '準備', t => store.createSubject(t, { name: '可售庫存', type: '指標', domain: 'INV', definition: '可下單佔用的庫存' }, AGENT));
  const { result: d } = await store.tx(OWNER, '建文檔', t => lib.create(t, { template: 'TPL-0001', title: '可售庫存說明', folder: '庫存', summary: '說明可售庫存。', subjects: [subj.id], body: `## 概述\n\n可售庫存。\n\n## 詳細說明\n\n見 [[${subj.id}]]。\n` }, OWNER));
  await store.tx(OWNER, '發布', t => lib.publish(t, d.id, {}, OWNER));
  const pub = lib.get(d.id).pub;
  const file = path.join(store.root, pub.path);

  // 直接在 Git 中改正文
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('## 概述\n\n可售庫存。', '## 概述\n\n可售庫存（在 Git 中修改）。'));
  // 新增一個沒有 front matter 的 .md、一個與已有文檔 ID 重複的檔案
  await fs.writeFile(path.join(store.root, 'docs', '庫存', '盤點說明.md'), '# 盤點說明\n\n每月一次。\n');
  await fs.writeFile(path.join(store.root, 'docs', '庫存', 'copy.md'), text);
  await store.repo.commit('直接編輯', { paths: [store.subdir] });
  await store.load();

  const h = await docHistory(lib, lib.get(d.id));
  assert.equal(h.editedInGit, true);
  assert.equal(h.events[0].type, 'git_edit');
  assert.ok(lib.get(d.id).pub.body.includes('在 Git 中修改'));
  assert.deepEqual(lib.unregistered.map(u => u.title), ['盤點說明']);
  assert.ok(store.loadErrors.some(e => /重複/.test(e.error) && e.file.endsWith('copy.md')), JSON.stringify(store.loadErrors));

  // 確認 Git 中的修改為新版本
  const { result: conf } = await store.tx(OWNER, '確認', t => lib.publish(t, d.id, { confirmGitEdit: true }, OWNER));
  assert.equal(conf.version, 2);
  assert.equal(lib.get(d.id).pub.meta.change.fromGit, true);

  // 登記待登記的檔案：補 front matter，作為草稿
  const { result: reg } = await store.tx(OWNER, '登記', t => lib.registerFile(t, { path: 'docs/庫存/盤點說明.md' }, OWNER));
  assert.match(reg.id, /^DOC-\d{4}$/);
  assert.equal(lib.get(reg.id).draft.meta.title, '盤點說明');
  assert.equal(lib.unregistered.length, 0);
  await store.load();
  assert.equal(lib.get(reg.id).draft.meta.status, '草稿');
});

test('圖片：只收圖片且內容與類型一致；其他人只能經由 API 讀取', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const cookie = await login(s);
  const up = await fetch(`${s.base}/api/v1/docs/DOC-0002/assets?name=flow.png`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png });
  assert.equal(up.status, 201, await up.clone().text());
  const fake = await fetch(`${s.base}/api/v1/docs/DOC-0002/assets?name=x.png`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: Buffer.from('<svg onload=alert(1)>') });
  assert.equal(fake.status >= 400 && fake.status < 500, true);
  const svg = await fetch(`${s.base}/api/v1/docs/DOC-0002/assets?name=x.svg`, { method: 'POST', headers: { cookie, 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg/>') });
  assert.equal(svg.status >= 400 && svg.status < 500, true);
  const list = (await s.admin('GET', '/api/v1/docs/DOC-0002/assets')).body.data;
  assert.equal(list.length, 1);
  const got = await fetch(`${s.base}${list[0].url}`, { headers: { cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.match(got.headers.get('content-security-policy'), /sandbox/);
});

test('gitWebUrl：GitHub、GitLab 給出網頁地址，其他遠端與帶憑證的地址不洩漏', () => {
  assert.equal(gitWebUrl('git@github.com:acme/kb.git', 'main', 'knowledge/docs/庫存/DOC-0001-x.md'), `https://github.com/acme/kb/blob/main/knowledge/docs/${encodeURIComponent('庫存')}/DOC-0001-x.md`);
  assert.equal(gitWebUrl('https://gitlab.com/acme/kb.git', 'dev', 'a/b.md'), 'https://gitlab.com/acme/kb/-/blob/dev/a/b.md');
  assert.equal(gitWebUrl('https://user:tok@github.com/acme/kb.git', 'main', 'a.md'), 'https://github.com/acme/kb/blob/main/a.md');
  assert.equal(gitWebUrl('https://git.example.com/acme/kb.git', 'main', 'a.md'), null);
  assert.equal(gitWebUrl('', 'main', 'a.md'), null);
  assert.equal(gitWebUrl('file:///tmp/repo', 'main', 'a.md'), null);
});

test('Markdown 渲染：轉義 HTML、拒絕危險鏈接、引用與章節解析', () => {
  const { html } = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[點我](javascript:alert(1)) [ok](https://example.com) ![p](data:text/html,x)\n\n`<b>`');
  assert.ok(!html.includes('<script'));
  assert.ok(!/<img[^>]*onerror/i.test(html));
  assert.ok(!/href="javascript:/i.test(html));
  assert.ok(!/src="data:text\/html/i.test(html));
  assert.ok(html.includes('href="https://example.com"'));
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref(' JaVaScRiPt:alert(1)'), null);
  assert.deepEqual(safeHref('https://a.b/c'), { href: 'https://a.b/c', external: true });
  const { html: refHtml } = renderMarkdown('見 [[S-INV-0012]] 與 [[DOC-0001#計算公式]]', { resolveRef: id => ({ label: id === 'S-INV-0012' ? '可售<庫存>' : '庫存口徑定義', state: 'ok', href: `#x/${id}` }) });
  assert.ok(refHtml.includes('可售&lt;庫存&gt;'));
  assert.ok(refHtml.includes('data-ref="DOC-0001"'));
  assert.deepEqual(extractRefs('[[S-INV-0012]] [[DOC-0001#計算公式]] `[[A-0001]]`').map(r => r.id).sort(), ['DOC-0001', 'S-INV-0012']);
  const secs = parseSections('前言\n## 甲\n內容\n```\n## 不是標題\n```\n### 乙\n');
  assert.deepEqual(secs.filter(x => x.heading).map(x => x.heading), ['甲', '乙']);
});
