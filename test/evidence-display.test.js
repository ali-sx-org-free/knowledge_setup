import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSourceInfo, evidenceSourceHtml } from '../web/assets/evidence.js';

const source = 'http://rpa.example.test:8081/agent-api/v1/runs/tech-dms-sql-show-create-table-20261122-120000-abcdef';

test('原始 DDL 以短標籤顯示，打開和複製仍保留完整 HTTP 地址', () => {
  for (const ref of [source, `${source}/files/output.json`]) {
    const info = evidenceSourceInfo(ref);
    assert.equal(info.href, ref);
    assert.equal(info.text, ref);
    assert.equal(info.label, '原始 DDL');
    assert.equal(info.hint, '2026-11-22');
    const html = evidenceSourceHtml(ref);
    assert.ok(html.includes(`href="${ref}"`));
    assert.ok(html.includes(`data-source-ref="${ref}"`));
    assert.match(html, /rel="noopener noreferrer"/);
    assert.ok(!html.replace(/<[^>]+>/g, '').includes('/agent-api/'), '長路徑只在詳情與屬性中，不出現在列表文字');
  }
});

test('HTTP 文件保持原始查詢參數和錨點，純文字與本地路徑不偽裝成原始請求', () => {
  const ref = 'https://example.com/ddl.json?version=3&table=order_sku#ddl';
  assert.equal(evidenceSourceInfo(ref).href, ref);
  assert.equal(evidenceSourceInfo(ref).hint, 'example.com');
  assert.ok(evidenceSourceHtml(ref).includes('version=3&amp;table=order_sku#ddl'));
  for (const text of ['/Users/user/data/ddl.json#sha256=abc', '用戶審核說明；原始證據：' + source]) {
    assert.equal(evidenceSourceInfo(text).href, null);
    assert.equal(evidenceSourceInfo(text).text, text);
  }
  assert.equal(evidenceSourceHtml(null), '');
});

test('來源內容不能注入 HTML 或執行非 HTTP 協議', () => {
  for (const text of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///Users/a/ddl.json', 'https://user:password@example.com/ddl', '"><img src=x onerror=alert(1)>']) {
    assert.equal(evidenceSourceInfo(text).href, null);
    const html = evidenceSourceHtml(text);
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('href='));
  }
});
