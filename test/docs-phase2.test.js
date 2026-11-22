// 文檔庫第二期（設計文件 §9.4、§19）：ZIP 讀寫、Word 與 PDF 轉 Markdown、主體手冊、四眼審閱、廢止時遷移依據、
// 按章節預選受影響的知識、內置校驗 Action、從文檔提取斷言、問答引用文檔、全局搜索、Markdown 壓縮包、AI 起草。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers.js';
import { createZip, readZip, crc32 } from '../src/services/zip.js';
import { convertToMarkdown } from '../src/services/doc-convert.js';
import { sentencesOf, guessType } from '../src/services/doc-ai.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function seeded(opts) {
  const s = await startServer(opts);
  const r = await s.admin('POST', '/admin/api/seed');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return s;
}

/** 以原始請求體上傳（導入 Word、PDF 用）。 */
async function rawPost(s, secretOrCookie, url, data, type = 'application/octet-stream') {
  const auth = secretOrCookie.startsWith('kk_') ? { authorization: `Bearer ${secretOrCookie}` } : { cookie: secretOrCookie };
  const res = await fetch(`${s.base}${url}`, { method: 'POST', headers: { ...auth, 'content-type': type }, body: data });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function secretFor(s, kind, role, name) {
  const r = await s.admin('POST', '/admin/api/keys', { name: name || `${kind}-${role}-${Math.random().toString(36).slice(2, 6)}`, kind, role });
  return r.body.data.secret;
}

// ---------------------------------------------------------------- 樣例檔案
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function makeDocx() {
  const p = (text, style, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${text}</w:p>`;
  const r = (t, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const li = (t, num) => p(r(t), 'ListParagraph', `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num}"/></w:numPr>`);
  const body = [
    p(r('補貨作業說明'), 'Title'),
    p(r('補貨前先確認') + r('安全庫存', '<w:b/>') + r('。')),
    p(r('補貨步驟'), 'Heading1'),
    li('查看缺貨清單。', 2), li('建立補貨單。', 2),
    p(r('詳見 ') + `<w:hyperlink r:id="rId9">${r('補貨規範')}</w:hyperlink>`),
    `<w:tbl><w:tr><w:tc>${p(r('角色'))}</w:tc><w:tc>${p(r('職責'))}</w:tc></w:tr><w:tr><w:tc>${p(r('計劃員'))}</w:tc><w:tc>${p(r('建單'))}</w:tc></w:tr></w:tbl>`,
    p('<w:r><w:drawing/></w:r>')
  ].join('');
  return createZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://wiki.example.com/replenish" TargetMode="External"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>' },
    { name: 'word/styles.xml', data: `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>` },
    { name: 'word/numbering.xml', data: `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>` },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>` }
  ]);
}

/** 手寫的最小 PDF：Type0 字體 + ToUnicode（中文）、Type1 Helvetica（英文）。 */
function makePdf() {
  const lines = [[24, 760, '庫存盤點規則'], [12, 720, '盤點後的差異需要複盤。'], [16, 680, '處理步驟'], [12, 650, '•主管查看差異清單'], [12, 632, '•財務審核調整單']];
  const chars = [...new Set(lines.map(l => l[2]).join(''))];
  const gid = c => (chars.indexOf(c) + 1).toString(16).padStart(4, '0').toUpperCase();
  const hex4 = c => c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase();
  const content = [...lines.map(([size, y, text]) => `BT /F1 ${size} Tf 72 ${y} Td <${[...text].map(gid).join('')}> Tj ET`), 'BT /F2 12 Tf 72 600 Td (Version 2 applies.) Tj ET'].join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map(c => `<${gid(c)}> <${hex4(c)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 8 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansCJK /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------- 測試
test('ZIP 讀寫：UTF-8 檔名、儲存與 Deflate、CRC、篩選與大小上限', () => {
  const big = 'ABCD'.repeat(5000);
  const zip = createZip([{ name: '文檔/說明.md', data: '# 你好\n' }, { name: 'big.txt', data: big }, { name: 'x.bin', data: Buffer.from([1, 2, 3]) }, { name: '文檔/說明.md', data: '重複的檔名只保留第一個' }]);
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ['文檔/說明.md', 'big.txt', 'x.bin']);
  assert.equal(files.get('文檔/說明.md').toString(), '# 你好\n');
  assert.equal(files.get('big.txt').toString(), big);
  assert.ok(zip.length < big.length / 10, '可壓縮的內容用 Deflate');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.deepEqual([...readZip(zip, { only: n => n.endsWith('.md') }).keys()], ['文檔/說明.md']);
  assert.throws(() => readZip(zip, { maxTotal: 100 }), /too large/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
});

test('Word、PDF 轉 Markdown：標題、粗體、有序列表、鏈接、表格、圖片提醒；PDF 的字號、列表與 ToUnicode', async () => {
  const docx = convertToMarkdown(makeDocx(), { name: 'a.docx' });
  assert.equal(docx.format, 'docx');
  assert.equal(docx.title, '補貨作業說明');
  assert.match(docx.body, /補貨前先確認\*\*安全庫存\*\*。/);
  assert.match(docx.body, /^## 補貨步驟$/m);
  assert.match(docx.body, /^1\. 查看缺貨清單。\n2\. 建立補貨單。$/m);
  assert.match(docx.body, /\[補貨規範\]\(https:\/\/wiki\.example\.com\/replenish\)/);
  assert.match(docx.body, /\| 角色 \| 職責 \|\n\| --- \| --- \|\n\| 計劃員 \| 建單 \|/);
  assert.ok(!docx.body.includes('javascript:'));
  assert.equal(docx.warnings.length, 1);

  const pdf = convertToMarkdown(makePdf(), { name: 'b.pdf' });
  assert.equal(pdf.format, 'pdf');
  assert.equal(pdf.title, '庫存盤點規則');
  assert.match(pdf.body, /盤點後的差異需要複盤。/);
  assert.match(pdf.body, /^## 處理步驟$/m);
  assert.match(pdf.body, /^- 主管查看差異清單$/m);
  assert.match(pdf.body, /^- 財務審核調整單$/m);
  assert.match(pdf.body, /Version 2 applies\./);

  // 驗收用的樣例（Chromium 生成的 PDF、手寫的 docx）
  const sample = convertToMarkdown(await fs.readFile(path.join(ROOT, 'docs/samples/stocktake-variance.pdf')), { name: 'x.pdf' });
  assert.equal(sample.title, '盤點差異處理說明');
  assert.match(sample.body, /^## 處理步驟$/m);
  assert.equal((sample.body.match(/^- /gm) || []).length, 3);
  const sampleDocx = convertToMarkdown(await fs.readFile(path.join(ROOT, 'docs/samples/stocktake-guide.docx')), { name: 'x.docx' });
  assert.equal(sampleDocx.title, '盤點作業說明');
  assert.match(sampleDocx.body, /^### 注意事項$/m);

  assert.throws(() => convertToMarkdown(Buffer.from('hello'), { name: 'a.txt' }), e => e.status === 415);
  assert.throws(() => convertToMarkdown(Buffer.from('%PDF-1.4\n%%EOF'), { name: 'a.pdf' }), e => e.status === 422);
});

test('導入 Word、PDF：convert 只轉換，import 建立草稿；消費者不能導入', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const human = await secretFor(s, 'human', 'contributor');
  const reader = await secretFor(s, 'agent', 'consumer');
  const conv = await rawPost(s, human, '/api/v1/docs/convert?name=a.docx', makeDocx());
  assert.equal(conv.status, 200, JSON.stringify(conv.body));
  assert.equal(conv.body.data.title, '補貨作業說明');
  const imp = await rawPost(s, human, `/api/v1/docs/import?name=${encodeURIComponent('補貨.docx')}&folder=${encodeURIComponent('計劃補貨')}`, makeDocx());
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.data.title, '補貨作業說明');
  assert.equal(imp.body.data.status, '草稿');
  assert.equal(imp.body.data.folder, '計劃補貨');
  assert.ok(imp.body.warnings.some(w => w.includes('圖片')));
  const pdf = await rawPost(s, human, '/api/v1/docs/import?name=b.pdf', makePdf());
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
  assert.equal(pdf.body.data.title, '庫存盤點規則');
  assert.equal((await rawPost(s, reader, '/api/v1/docs/convert?name=a.docx', makeDocx())).status, 403);
  assert.equal((await rawPost(s, human, '/api/v1/docs/convert?name=a.exe', Buffer.from('MZ....'))).status, 415);
});

test('主體手冊：生成直接發布、正文只讀、知識變化後落後、重新生成產生新版本；只能由人觸發；不作為證據', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const owner = await s.keyFor('human', 'owner');
  const agent = await s.keyFor('agent', 'contributor');
  assert.equal((await agent('POST', '/api/v1/docs/generate', { subjectId: 'S-INV-0012' })).status, 403);
  assert.equal((await owner('POST', '/api/v1/docs/generate', { subjectId: 'S-INV-0016' })).status, 422, '別名不能生成手冊');

  const g = await owner('POST', '/api/v1/docs/generate', { subjectId: 'S-INV-0012' });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const id = g.body.data.id;
  assert.equal(g.body.data.folder, '庫存/手冊');
  let d = (await owner('GET', `/api/v1/docs/${id}`)).body.data;
  assert.equal(d.status, '已發布');
  assert.equal(d.version, 1);
  assert.equal(d.objectId, null, '手冊不登記客體');
  assert.equal(d.templateInfo.generator, 'handbook');
  assert.equal(d.generated.stale, false);
  assert.match(d.body, /\[\[A-0001\]\] · L0 可靠/);
  assert.match(d.body, /### 已失效（不得作為依據）\n\n- ~~/);
  assert.match(d.body, /## 可用 Action/);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(d.body), '正文不含日期');

  const again = await owner('POST', `/api/v1/docs/${id}/regenerate`);
  assert.equal(again.body.data.changed, false);
  assert.equal(again.body.commit, null, '沒有變化不提交');
  assert.equal((await owner('PUT', `/api/v1/docs/${id}/draft`, { body: '## 改' })).body.error.code, 'generated_doc');
  assert.equal((await owner('POST', `/api/v1/docs/${id}/extract`, { subjectId: 'S-INV-0012', content: '手冊裡的話' })).status, 409);

  // 知識變化：手冊落後，重新生成
  const a = await owner('POST', '/api/v1/subjects/S-INV-0012/assertions', { type: '屬性', content: '可售庫存每 5 分鐘對賬一次', evidence: { sourceRef: '口頭' } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  d = (await owner('GET', `/api/v1/docs/${id}`)).body.data;
  assert.equal(d.generated.stale, true);
  const re = await owner('POST', '/api/v1/docs/generate', { subjectId: 'S-INV-0012' });
  assert.equal(re.status, 200, '已有手冊時重新生成');
  assert.equal(re.body.data.id, id);
  assert.equal(re.body.data.version, 2);
  d = (await owner('GET', `/api/v1/docs/${id}`)).body.data;
  assert.equal(d.generated.stale, false);
  assert.match(d.body, /每 5 分鐘對賬一次/);

  // 領域手冊、知識卡、智能視圖
  const dom = await owner('POST', '/api/v1/docs/generate', { domain: 'INV' });
  assert.equal(dom.status, 201);
  assert.equal(dom.body.data.title, '庫存領域手冊');
  const card = (await owner('GET', '/api/v1/subjects/S-INV-0012')).body.data;
  assert.ok(card.documents.find(x => x.id === id).generated);
  const unlinked = (await owner('GET', '/api/v1/docs?view=unlinked')).body.data;
  assert.ok(!unlinked.some(x => x.id === dom.body.data.id), '領域手冊沒有關聯主體，也不算「未關聯」');
});

test('四眼審閱：模板開啟後，這一版的作者不能自己發布，另一位負責人可以', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const a = await s.keyFor('human', 'owner', 'owner-a');
  const b = await s.keyFor('human', 'owner', 'owner-b');
  const src = (await a('GET', '/api/v1/doc-templates/TPL-0004?source=1')).body.data.source;
  const put = await a('PUT', '/api/v1/doc-templates/TPL-0004', { ...src, requireOtherApprover: true });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.data.requireOtherApprover, true);
  const d = (await a('GET', '/api/v1/docs/DOC-0001')).body.data;
  assert.equal((await a('PUT', '/api/v1/docs/DOC-0001/draft', { etag: d.etag, body: d.body.replace('## 示例', '## 示例\n\n補一個例子。') })).status, 200);
  const self = await a('POST', '/api/v1/docs/DOC-0001/publish', {});
  assert.equal(self.status, 403);
  assert.equal(self.body.error.code, 'four_eyes_required');
  const other = await b('POST', '/api/v1/docs/DOC-0001/publish', {});
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const v = (await b('GET', '/api/v1/docs/DOC-0001')).body.data;
  assert.equal(v.change.authors.length, 1);
  assert.notEqual(v.change.authors[0].id, v.change.publishedBy.id);
});

test('內置校驗 Action：文檔已發布即客體存在，綁定文檔客體的綁定可以校驗到 L0；廢止後不再存在；內置管道不能修改', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const owner = await s.keyFor('human', 'owner');
  const pipes = (await owner('GET', '/api/v1/pipelines')).body.data;
  const p = pipes.find(x => x.type === 'docs');
  assert.ok(p?.builtin, '首次發布文檔時建立內置管道');
  const act = (await owner('GET', '/api/v1/actions')).body.data.find(x => x.pipelineId === p.id);
  assert.equal(act.check.mode, 'exists');
  assert.equal((await owner('PUT', `/api/v1/pipelines/${p.id}`, { ...p, name: '改名' })).body.error.code, 'builtin');
  assert.equal((await owner('PUT', `/api/v1/actions/${act.id}`, { ...act, name: '改名' })).body.error.code, 'builtin');
  assert.equal((await owner('POST', `/api/v1/pipelines/${p.id}/test`)).body.data.ok, true);

  const obj = (await owner('GET', '/api/v1/objects/O-0001')).body.data;
  assert.ok(obj.actionIds.includes(act.id));
  const b = await owner('POST', '/api/v1/subjects/S-INV-0015/bindings', { objectId: 'O-0001', note: '缺貨率的口徑也在這份文檔裡' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.data.validity.level, 'L1');
  const v = await owner('POST', `/api/v1/validate/${b.body.data.id}`);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.outcome, 'pass');
  assert.equal(v.body.data.level, 'L0');
  assert.match(v.body.data.request.url, /^docs:\/\//);
  assert.equal((await owner('POST', '/api/v1/docs/DOC-0001/obsolete', { reason: '測試廢止' })).status, 200);
  assert.equal(s.srv.ctx.store.docs.docObjectStatus('O-0001').status, 410, '廢止後客體不再存在');
  assert.equal(s.srv.ctx.store.docs.docObjectStatus('O-0002').status, 404, '不由文檔庫管理的客體');
});

test('按章節預選：sourceRef 指向沒改的章節時不預選；改了那一節就預選', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const owner = await s.keyFor('human', 'owner');
  const ex = await owner('POST', '/api/v1/docs/DOC-0001/extract', { items: [{ subjectId: 'S-INV-0012', type: '約束', content: '在途調撥的數量不計入任何一倉的可售庫存', anchor: '邊界情況' }] });
  assert.equal(ex.status, 201, JSON.stringify(ex.body));
  const aid = ex.body.data.created[0].id;
  assert.equal(ex.body.data.created[0].level, 'L1');
  assert.equal(ex.body.data.created[0].sourceRef, 'DOC-0001§邊界情況 v4');
  const dup = await owner('POST', '/api/v1/docs/DOC-0001/extract', { subjectId: 'S-INV-0012', type: '約束', content: '在途調撥的數量，不計入任何一倉的可售庫存。', anchor: '邊界情況' });
  assert.equal(dup.body.data.created.length, 0);
  assert.equal(dup.body.data.skipped.length, 1);

  let d = (await owner('GET', '/api/v1/docs/DOC-0001')).body.data;
  await owner('PUT', '/api/v1/docs/DOC-0001/draft', { etag: d.etag, body: d.body.replace('## 示例', '## 示例\n\n補一個例子。') });
  let imp = (await owner('GET', '/api/v1/docs/DOC-0001/impact')).body.data;
  assert.equal(imp.sectionAware, true);
  assert.deepEqual(imp.changedSections.map(x => x.heading), ['示例']);
  let it = imp.items.find(x => x.id === aid);
  assert.equal(it.section, '邊界情況');
  assert.equal(it.sectionChange, 'unchanged');
  assert.equal(it.suggested, false);
  assert.ok(imp.items.filter(x => !x.sourceRef).every(x => x.suggested), '沒有 sourceRef 的一律預選');

  d = (await owner('GET', '/api/v1/docs/DOC-0001?draft=1')).body.data;
  await owner('PUT', '/api/v1/docs/DOC-0001/draft', { etag: d.etag, body: d.body.replace('在途調撥的數量不計入任何一倉的可售庫存。', '在途調撥的數量計入調入倉的可售庫存。') });
  imp = (await owner('GET', '/api/v1/docs/DOC-0001/impact')).body.data;
  it = imp.items.find(x => x.id === aid);
  assert.equal(it.sectionChange, 'modified');
  assert.equal(it.suggested, true);
});

test('從文檔提取斷言的建議：按章節的 knowledge 提示猜類型、按引用找主體；選中文字也能建議', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const owner = await s.keyFor('human', 'owner');
  const r = (await owner('POST', '/api/v1/docs/DOC-0001/extract-suggestions', {})).body.data;
  assert.equal(r.composer.type, 'rule');
  const def = r.items.find(x => x.heading === '定義');
  assert.equal(def.subjectId, 'S-INV-0012');
  assert.equal(def.type, '定義', '口徑定義模板的「定義」章節提示定義類');
  assert.ok(!def.content.includes('[['), '引用換成名稱');
  const edge = r.items.find(x => x.heading === '邊界情況');
  assert.equal(edge.type, '約束');
  const one = (await owner('POST', '/api/v1/docs/DOC-0001/extract-suggestions', { text: '在途調撥的數量不計入任何一倉的可售庫存。', anchor: '邊界情況' })).body.data;
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].subjectId, 'S-INV-0012');
  assert.equal(one.items[0].type, '約束');
  assert.deepEqual(sentencesOf('- 第一條。第二條；\n| a | b |\n| --- | --- |\n```\n代碼\n```'), ['第一條。', '第二條；', 'a，b']);
  assert.equal(guessType('預佔超過 30 分鐘就釋放'), '規則');
  assert.equal(guessType('不得對外展示負數'), '約束');
});

test('廢止時遷移依據：綁定了舊文檔客體的主體改為綁定替代文檔的客體（L1）；也可以事後補做', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const owner = await s.keyFor('human', 'owner');
  const old = (await owner('GET', '/api/v1/docs/DOC-0001')).body.data;
  const n = await owner('POST', '/api/v1/docs', { template: 'TPL-0004', title: '庫存口徑定義（2027 版）', folder: '庫存/口徑', summary: '2027 年起的庫存口徑', owner: '庫存域架構師', fields: old.fields, subjects: old.subjects, body: old.body });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  const pub = await owner('POST', `/api/v1/docs/${n.body.data.id}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal((await owner('POST', '/api/v1/docs/DOC-0001/migrate-basis')).body.error.code, 'not_obsolete');

  const ob = await owner('POST', '/api/v1/docs/DOC-0001/obsolete', { reason: '由 2027 版替代', replacedBy: n.body.data.id, migrate: true });
  assert.equal(ob.status, 200, JSON.stringify(ob.body));
  assert.ok(ob.body.data.migrated.length >= 1);
  const m = ob.body.data.migrated.find(x => x.subjectId === 'S-INV-0012');
  assert.equal(m.objectId, pub.body.data.objectId);
  assert.equal(m.level, 'L1');
  assert.match(ob.body.commit ? 'ok' : '', /ok/);
  const card = (await owner('GET', '/api/v1/subjects/S-INV-0012')).body.data;
  assert.equal(card.bindings.find(b => b.object.id === 'O-0001').level, 'E1');
  assert.equal(card.bindings.find(b => b.object.id === pub.body.data.objectId).level, 'L1');
  const again = await owner('POST', '/api/v1/docs/DOC-0001/migrate-basis');
  assert.equal(again.status, 200);
  assert.equal(again.body.data.migrated.length, 0, '已經遷移過的主體跳過');
});

test('問答引用文檔：結構化知識之外附文檔章節原文，引用格式〔DOC-…§章節·v…〕，與知識引用分開；生成的手冊不參與', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const owner = await s.keyFor('human', 'owner');
  await owner('POST', '/api/v1/docs/generate', { subjectId: 'S-INV-0012' });
  const reader = await s.keyFor('agent', 'consumer');
  const r = (await reader('POST', '/api/v1/ask', { question: '可售庫存怎麼計算？', compose: 'template' })).body.data;
  assert.equal(r.status, 'answered');
  assert.equal(r.documents[0].docId, 'DOC-0001');
  assert.equal(r.documents[0].heading, '計算公式');
  assert.equal(r.documents[0].cite, '〔DOC-0001§計算公式·v4〕');
  assert.ok(!r.documents.some(d => d.title.includes('手冊')));
  assert.match(r.answer, /文檔原文（補充，不屬於結構化知識，沒有層級）：\n· 《庫存口徑定義》§計算公式：.+〔DOC-0001§計算公式·v4〕/);
  assert.ok(!r.citations.some(c => c.id.startsWith('DOC-')), '文檔不進知識引用');
  const off = (await reader('POST', '/api/v1/ask', { question: '可售庫存怎麼計算？', compose: 'template', includeDocuments: false })).body.data;
  assert.deepEqual(off.documents, []);
  assert.ok(!off.answer.includes('文檔原文'));
});

test('問答引用文檔（模型）：文檔原文作為 documents 交給模型，答案中引用的標為 cited', async t => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    if (String(url).startsWith('https://openrouter.test/')) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const user = JSON.parse(body.messages.at(-1).content);
      const cite = user.documents?.[0]?.cite || '';
      const content = JSON.stringify({ covered: true, answer: `可售庫存 = 實物庫存 − 已預佔 − 凍結 − 安全庫存〔A-0001·L0〕。文檔原文：按 SKU + 倉庫計算${cite}`, citations: [{ id: 'A-0001', level: 'L0' }], documents: [cite], missingInfo: null });
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, init);
  };
  const s = await seeded({ fetchImpl: fakeFetch, env: { OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE_URL: 'https://openrouter.test/api/v1', OPENROUTER_MODEL: 'test/model' } });
  t.after(() => s.close());
  const reader = await s.keyFor('agent', 'consumer');
  const r = (await reader('POST', '/api/v1/ask', { question: '可售庫存怎麼計算？' })).body.data;
  assert.equal(r.composer.type, 'openrouter');
  assert.equal(r.documents[0].cited, true);
  assert.match(calls.at(-1).messages[0].content, /documents 是文檔原文，只作補充/);
});

test('全局搜索：主體（名稱、別名、定義）和文檔一起返回', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const reader = await s.keyFor('agent', 'consumer');
  const r = (await reader('GET', '/api/v1/search?q=ATP')).body.data;
  assert.equal(r.subjects[0].id, 'S-INV-0012');
  assert.equal(r.subjects[0].match.field, 'alias');
  assert.ok(r.documents.some(d => d.id === 'DOC-0001'), '別名解析後，關聯了可售庫存的文檔也命中');
  const byName = (await reader('GET', `/api/v1/search?q=${encodeURIComponent('可售庫存')}`)).body.data;
  assert.equal(byName.subjects[0].id, 'S-INV-0012');
  assert.equal(byName.subjects[0].score >= 100, true);
  assert.equal((await reader('GET', '/api/v1/search')).status, 400);
});

test('導出 Markdown 壓縮包：已發布的文檔按文件夾放好、帶 front matter 和 README 索引，[[ID]] 改為名稱或包內鏈接', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const reader = await secretFor(s, 'agent', 'consumer');
  const res = await fetch(`${s.base}/api/v1/docs/export?format=zip`, { headers: { authorization: `Bearer ${reader}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  const names = [...files.keys()];
  assert.ok(names.includes('README.md'));
  assert.ok(names.includes('庫存/口徑/DOC-0001-庫存口徑定義.md'));
  assert.ok(!names.some(n => n.includes('DOC-0002')), '從未發布的草稿不導出');
  const md = files.get('庫存/口徑/DOC-0001-庫存口徑定義.md').toString();
  assert.match(md, /^---\nid: DOC-0001\n/);
  assert.match(md, /可售庫存（S-INV-0012）/);
  const guide = files.get('通用/DOC-0003-知識庫寫作指南.md').toString();
  assert.match(guide, /\[庫存口徑定義(§[^\]]+)?\]\(\.\.\/庫存\/口徑\/DOC-0001-庫存口徑定義\.md/, '文檔引用改為包內相對鏈接');
  assert.match(files.get('README.md').toString(), /\[DOC-0001 庫存口徑定義\]\(庫存\/口徑\/DOC-0001-庫存口徑定義\.md\)/);
  assert.equal((await fetch(`${s.base}/api/v1/docs/export?format=pdf`, { headers: { authorization: `Bearer ${reader}` } })).status, 400);
});

test('AI 起草（模板）：只取選中主體 L0、L1 的知識並附引用，草稿標記 AI 起草；發布後記在版本說明裡', async t => {
  const s = await seeded();
  t.after(() => s.close());
  const human = await s.keyFor('human', 'contributor');
  const owner = await s.keyFor('human', 'owner');
  const pre = await human('POST', '/api/v1/docs/ai-draft', { template: 'TPL-0001', subjectIds: ['S-INV-0012'], compose: 'template', preview: true });
  assert.equal(pre.status, 200);
  assert.equal(pre.body.data.composer.type, 'template');
  const body = pre.body.data.body;
  assert.match(body, /\[\[A-0001\]\]/);
  assert.match(body, /（未經驗證） \[\[A-0003\]\]/, 'L1 標註未經驗證');
  assert.ok(!body.includes('A-0004'), '不取 E1');
  assert.ok(!body.includes('R-0020'), '不取 L2');
  assert.match(body, /<!-- 提示：本稿由模板按知識自動起草/);
  assert.equal(pre.body.data.title, '可售庫存知識條目');

  const r = await human('POST', '/api/v1/docs/ai-draft', { template: 'TPL-0004', subjectIds: ['S-INV-0016'], instruction: '寫給新同事', compose: 'template', title: '可售庫存口徑（AI 草稿）' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.data.id;
  assert.equal(r.body.data.status, '草稿');
  assert.deepEqual(r.body.data.aiDraft.subjects, ['S-INV-0012'], '別名換成規範主體');
  assert.equal(r.body.data.fields.metric, 'S-INV-0012', '主體欄位按類型預填');
  const d = (await owner('GET', `/api/v1/docs/${id}`)).body.data;
  assert.equal(d.aiDraft.instruction, '寫給新同事');
  const md = await fetch(`${s.base}/api/v1/docs/${id}?format=md`, { headers: { cookie: '' } });
  assert.equal(md.status, 401);

  assert.equal((await human('POST', '/api/v1/docs/ai-draft', { template: 'TPL-0001', subjectIds: [] })).status, 400);
  assert.equal((await human('POST', '/api/v1/docs/ai-draft', { template: 'TPL-0007', subjectIds: ['S-INV-0012'] })).status, 422, '生成模板不能用來起草');
});

test('AI 起草（模型）：按模板章節組織，刪掉知識庫裡不存在的引用並提醒', async t => {
  const fakeFetch = async (url, init) => {
    if (String(url).startsWith('https://openrouter.test/')) {
      const body = JSON.parse(init.body);
      const content = JSON.stringify({ summary: '可售庫存的口徑說明', sections: [{ heading: '概述', body: '可售庫存是可以下單佔用的數量 [[A-0001]]，另見 [[A-9999]]。' }, { heading: '詳細說明', body: '計算結果為負時對外按 0 展示（未經驗證）[[A-0003]]。' }] });
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, init);
  };
  const s = await seeded({ fetchImpl: fakeFetch, env: { OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE_URL: 'https://openrouter.test/api/v1', OPENROUTER_MODEL: 'test/model' } });
  t.after(() => s.close());
  const human = await s.keyFor('human', 'contributor');
  const r = await human('POST', '/api/v1/docs/ai-draft', { template: 'TPL-0001', subjectIds: ['S-INV-0012'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.composer.type, 'openrouter');
  assert.equal(r.body.data.summary, '可售庫存的口徑說明');
  assert.ok(r.body.warnings.some(w => w.includes('1')), '提醒刪掉的引用');
  const d = (await human('GET', `/api/v1/docs/${r.body.data.id}?draft=1`)).body.data;
  assert.match(d.body, /## 概述\n\n可售庫存是可以下單佔用的數量 \[\[A-0001\]\]，另見 。/);
  assert.ok(!d.body.includes('A-9999'));
  assert.match(d.body, /## 示例\n\n## 常見問題\n\n<!-- 提示：/, '沒寫的章節保留提示');
  assert.equal(d.aiDraft.composer, 'openrouter');
  assert.equal(d.aiDraft.model, 'test/model');
});
