import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory } from '../web/assets/history.js';

const entry = (id, overrides = {}) => ({
  hash: String(id), author: '管理員', email: 'admin@human.knowledge',
  date: '2026-11-22T17:44:45+08:00',
  subject: `[失效] A-${id} → E1：字典移回 DOC-0002`, ...overrides
});

test('批量治理折疊後仍保留全部提交及原始順序', () => {
  const history = [entry(99, { subject: '[重建] 全量字段斷言與文檔' }), ...Array.from({ length: 48 }, (_, i) => entry(71 - i))];
  const snapshot = structuredClone(history);
  const groups = groupHistory(history);
  assert.deepEqual(groups.map(g => g.entries.length), [1, 48]);
  assert.equal(groups[1].operation, 'invalidate');
  assert.deepEqual(groups.flatMap(g => g.entries), snapshot);
  assert.deepEqual(history, snapshot);
});

test('不同原因、操作者或目標種類不會被誤合併', () => {
  for (const overrides of [
    { subject: '[失效] A-2 → E1：字典移回 DOC-0003' },
    { author: '另一位管理員' },
    { email: 'someone-else@human.knowledge' },
    { subject: '[失效] B-2 → E1：字典移回 DOC-0002' },
    { subject: '[確認] A-2 → L0' }
  ]) assert.equal(groupHistory([entry(1), entry(2, overrides)]).length, 2);
});

test('只有相鄰且總跨度五分鐘內的操作會合併，缺失日期不合併', () => {
  const history = [entry(1), entry(2, { date: '2026-11-22T17:40:00+08:00' }), entry(3, { date: '2026-11-22T17:39:30+08:00' })];
  assert.deepEqual(groupHistory(history).map(g => g.entries.length), [2, 1]);
  assert.equal(groupHistory([entry(1), entry(2, { subject: '[重建] 重寫文檔' }), entry(3)]).length, 3);
  assert.equal(groupHistory([entry(1), entry(2, { date: 'invalid' })]).length, 2);
  assert.equal(groupHistory([entry(1), entry(2, { date: '2026-11-22T17:45:00+08:00' })]).length, 2);
});

test('確認操作可合併，空歷史及單條歷史保持可用', () => {
  assert.deepEqual(groupHistory([]), []);
  assert.equal(groupHistory([entry(1)]).length, 1);
  const groups = groupHistory([entry(1, { subject: '[確認] A-1 → L0（負責人 admin）' }), entry(2, { subject: '[確認] A-2 → L0（負責人 admin）' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].operation, 'confirm');
});
