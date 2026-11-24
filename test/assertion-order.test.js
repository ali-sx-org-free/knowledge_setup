import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDdlCommentsFirst, ddlCommentPriority } from '../web/assets/assertion-order.js';
import { localSource } from '../web/assets/workspace.js';

const rows = [
  { id: 'A-0001', subject: '甲', structured: { key: 't.primary_key' } },
  { id: 'A-0002', subject: '乙', structured: { key: 't.f.ddl_comment', value: null } },
  { id: 'A-0003', subject: '甲', structured: { key: 't.f.ddl_comment', value: '原始注释' } },
  { id: 'A-0004', subject: '甲', structured: { key: 't.f.comment_enum' } },
  { id: 'A-0005', subject: '乙' }
];
const source = localSource({ load: async () => rows, text: r => r.id, groups: [], sorts: { ddl_comment: ddlCommentPriority, subject: r => r.subject, id: r => r.id }, tieBreak: compareDdlCommentsFirst });
const page = (sort, offset = 0, limit = 20) => source.page({ q: '', filters: {}, sort }, offset, limit);

test('原始 DDL 注釋優先於枚舉和表結構，空注釋也屬於原始證據', async () => {
  assert.deepEqual([...rows].sort(compareDdlCommentsFirst).map(x => x.id), ['A-0002', 'A-0003', 'A-0001', 'A-0004', 'A-0005']);
  const result = await page('ddl_comment', 0, 2);
  assert.deepEqual(result.rows.map(x => x.id), ['A-0002', 'A-0003']);
  assert.equal(result.total, 5);
  assert.equal(rows[0].id, 'A-0001');
});

test('按主體排序時，每個主體內原始注釋優先；明確按 ID 排序仍可用', async () => {
  for (const sort of ['subject', '-subject']) {
    const result = (await page(sort)).rows;
    for (const subject of ['甲', '乙']) {
      const items = result.filter(x => x.subject === subject);
      assert.equal(ddlCommentPriority(items[0]), 0);
    }
  }
  assert.deepEqual((await page('id')).rows.map(x => x.id), rows.map(x => x.id));
  assert.deepEqual((await page('-id')).rows.map(x => x.id), [...rows].reverse().map(x => x.id));
});
