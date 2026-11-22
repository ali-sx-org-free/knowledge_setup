// 多語言：字典完整性、語言協商、API 錯誤與教程按請求語言返回、寫入知識倉庫的內容保持繁體原文、後台語言偵測。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { report } from '../scripts/i18n-check.js';
import { matchLocale, negotiate, tr, runWithLocale } from '../src/i18n/index.js';
import { maskSecret, isMaskedSecret } from '../src/config.js';
import { detectLocale, DATA_PATTERNS } from '../web/assets/i18n.js';

let t;
before(async () => {
  t = await startServer();
  const seed = await t.admin('POST', '/admin/api/seed');
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
});
after(() => t.close());

test('字典完整：後台與服務端的簡中、英文字典覆蓋全部原文，佔位符一致', async () => {
  for (const r of await report()) {
    assert.deepEqual(r.missing, [], `[${r.kind} ${r.locale}] 缺少`);
    assert.deepEqual(r.badPlaceholders, [], `[${r.kind} ${r.locale}] 佔位符不一致`);
    assert.deepEqual(r.empty, [], `[${r.kind} ${r.locale}] 譯文為空`);
  }
});

test('語言協商：?lang、Accept-Language（按 q 值）、繁簡地區標記', () => {
  assert.equal(matchLocale('zh-HK'), 'zh-TW');
  assert.equal(matchLocale('zh_Hant_TW'), 'zh-TW');
  assert.equal(matchLocale('zh-SG'), 'zh-CN');
  assert.equal(matchLocale('zh'), 'zh-CN');
  assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(matchLocale('fr'), null);
  assert.equal(negotiate('fr-FR,en;q=0.8,zh-CN;q=0.9'), 'zh-CN');
  assert.equal(negotiate('fr, *'), null);
  assert.equal(tr('找不到管道 {id}', { id: 'P-1' }, 'en'), 'Pipeline P-1 not found');
  assert.equal(tr('找不到管道 {id}', { id: 'P-1' }, 'zh-CN'), '找不到管道 P-1');
  assert.equal(tr('rel|擁有', null, 'zh-TW'), '擁有', '繁體去掉上下文前綴');
  assert.equal(runWithLocale('en', () => tr('需要登入')), 'Sign-in required');
});

test('API 錯誤訊息按請求語言返回，預設繁體；回應帶 Content-Language', async () => {
  const zh = await t.call('GET', '/api/v1/subjects');
  assert.equal(zh.status, 401);
  assert.match(zh.body.error.message, /需要身份驗證/);
  assert.equal(zh.headers.get('content-language'), 'zh-TW');

  const en = await t.call('GET', '/api/v1/subjects', undefined, { 'accept-language': 'en-US,en;q=0.9' });
  assert.equal(en.body.error.code, 'unauthorized', '錯誤碼不翻譯');
  assert.match(en.body.error.message, /^Authentication required/);
  assert.equal(en.headers.get('content-language'), 'en');

  const cn = await t.call('GET', '/api/v1/subjects?lang=zh-CN', undefined, { 'accept-language': 'en' });
  assert.match(cn.body.error.message, /需要身份验证/, '?lang 優先於 Accept-Language');

  const consumer = await t.keyFor('agent', 'consumer', 'i18n-reader');
  const missing = await consumer('GET', '/api/v1/subjects/S-INV-9999?lang=en');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.message, 'Subject S-INV-9999 not found');

  const bad = await fetch(`${t.base}/api/v1/ask?lang=en`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.match((await bad.json()).error.message, /^The request body is not valid JSON/);
});

test('教程與 Schema：說明按語言返回，枚舉值保持繁體原文', async () => {
  const en = await t.call('GET', '/api/v1/prompt?lang=en');
  assert.equal(en.status, 200);
  for (const s of ['agent knowledge production guide', '**Write cap**', 'You cannot write L0', 'Agent usage rules', '擁有 (owns)']) assert.ok(en.body.includes(s), `缺少：${s}`);
  assert.ok(en.body.includes('"type": "指標"'), '示例中的枚舉值不翻譯');
  assert.ok(!en.body.includes('寫入上限'), '英文教程不含繁體段落');

  const cn = await t.call('GET', '/api/v1/prompt?role=consumer', undefined, { 'accept-language': 'zh-CN' });
  assert.ok(cn.body.includes('智能体使用规约'));
  assert.ok(cn.body.includes('指標（指标）'), '表格中枚舉值附簡體譯名');

  const schema = (await t.call('GET', '/api/v1/schema?lang=en')).body.data;
  assert.equal(schema.locale, 'en');
  assert.deepEqual(Object.keys(schema.subjectTypes), ['系統', '業務對象', '流程', '規則', '指標', '別名']);
  assert.equal(schema.subjectTypes.指標.label, 'Metric');
  assert.equal(schema.subjectTypes.指標.en, 'metric');
  assert.equal(schema.levels.L0.usage, 'Use directly as a basis');
  assert.deepEqual(schema.relationTypes.擁有.from, ['系統']);

  const api = (await t.call('GET', '/api/v1/openapi.json?lang=en')).body;
  assert.equal(api.paths['/ask'].post.summary, 'Q&A: returns a natural-language answer, citations (with levels), structured knowledge cards, and supplementary text from related document sections (documents, kept separate from knowledge citations)');
  assert.equal(api.paths['/ask'].post['x-role'], 'consumer');
});

test('問答模板按語言組織答案；寫入知識倉庫的內容保持繁體原文', async () => {
  const consumer = await t.keyFor('agent', 'consumer', 'i18n-asker');
  const def = (await consumer('POST', '/api/v1/ask?lang=en', { question: '可售庫存怎麼算？', compose: 'template' })).body.data;
  assert.equal(def.status, 'answered');
  assert.match(def.answer, /^According to "可售庫存" in the knowledge base \(S-INV-0012, Metric, overall level L0\):/);
  assert.match(def.answer, /〔A-0001·L0 reliable〕/);
  assert.equal(def.usageRules.L1, 'May be used, but must be marked as unverified');

  const gap = (await consumer('POST', '/api/v1/ask', { question: '量子糾纏調度器的吞吐上限', compose: 'template' })).body.data;
  assert.equal(gap.status, 'uncovered');

  const agent = await t.keyFor('agent', 'contributor', 'i18n-writer');
  const created = await agent('POST', '/api/v1/subjects?lang=en', { name: '多語言測試主體', type: '指標', domain: 'INV', level: 'L0' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.warnings.some(w => w.startsWith('Consider adding a definition')), '提示按請求語言');
  const card = (await consumer('GET', `/api/v1/subjects/${created.body.data.id}?history=1`)).body.data;
  const log = (await t.admin('GET', '/admin/api/log?limit=5')).body.data;
  assert.ok(log.some(c => c.subject.includes('[生產] 新增主體') && c.subject.includes('多語言測試主體')), '提交說明保持繁體');
  assert.ok(card.subject, '知識卡可讀');

  const gaps = (await t.admin('GET', '/api/v1/gaps')).body.data;
  assert.ok(gaps.some(g => g.reason === '術語未命中任何主體'), '知識缺口原因保持繁體');
});

test('機密遮罩：每種語言的遮罩提交回來都視為不修改', () => {
  for (const l of ['zh-TW', 'zh-CN', 'en']) {
    const m = runWithLocale(l, () => maskSecret('sk-or-abcdef1234'));
    assert.ok(m.includes('1234'), m);
    assert.ok(isMaskedSecret(m), m);
  }
  assert.ok(!isMaskedSecret('sk-or-new-key'));
  assert.ok(!isMaskedSecret('Set (…12345678)'), '尾碼超過 4 位不是遮罩');
});

test('後台語言偵測與持久化短語的匹配規則', () => {
  assert.equal(detectLocale({ search: '?lang=en', stored: 'zh-CN', languages: ['zh-TW'] }), 'en');
  assert.equal(detectLocale({ stored: 'zh-CN', languages: ['en'] }), 'zh-CN');
  assert.equal(detectLocale({ languages: ['fr-FR', 'zh-HK'] }), 'zh-TW');
  assert.equal(detectLocale({ languages: ['zh-CN'] }), 'zh-CN');
  assert.equal(detectLocale({ languages: ['fr-FR'] }), 'en', '不支持的語言回退英文');
  for (const [template, re] of DATA_PATTERNS) {
    const sample = template.replace(/\{(\w+)\}/g, (_, k) => (k === 'status' || k === 'version' ? '200' : k === 'id' && template.startsWith('裁決') ? 'C-0001' : k === 'id' && /v\{version\}|^文檔/.test(template) ? 'DOC-0001' : `X${k}`));
    assert.match(sample, re, template);
  }
});
