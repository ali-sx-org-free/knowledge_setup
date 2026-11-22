// 導入 Word、PDF（設計 §9.4）：把 .docx、.pdf 轉成 Markdown，作為草稿正文。不引入依賴。
// Word：讀 word/document.xml，按樣式識別標題（Title、Heading 1–3），保留段落、清單、表格、粗體、斜體和鏈接；圖片不導入。
// PDF：讀頁面內容流裡的文字（支持 FlateDecode、物件流、ToUnicode 對照表與字寬），按位置拼行、按行距分段、按字號識別標題。
// 掃描件（沒有文字層）和加密的 PDF 不支持。轉換結果一律要人核對，體檢會指出缺哪些章節。
import zlib from 'node:zlib';
import { readZip } from './zip.js';
import { RuleError } from '../store/validity.js';
import { tr } from '../i18n/index.js';

export const CONVERT_MAX = 20 * 1024 * 1024;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function sniffFormat(buf, name = '', contentType = '') {
  const lower = String(name).toLowerCase();
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.readUInt32LE?.(0) === 0x04034b50) return 'docx';
  if (contentType === DOCX_TYPE || lower.endsWith('.docx')) return 'docx';
  if (contentType === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  return null;
}

/** 轉換入口：返回 { format, title, body, warnings }。 */
export function convertToMarkdown(buf, { name = '', contentType = '' } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new RuleError(tr('沒有收到檔案內容'), 400, 'invalid_input');
  if (buf.length > CONVERT_MAX) throw new RuleError(tr('檔案超過 {n} MB', { n: CONVERT_MAX / 1024 / 1024 }), 413, 'file_too_large');
  const format = sniffFormat(buf, name, contentType);
  if (format === 'docx') return { format, ...docxToMarkdown(buf) };
  if (format === 'pdf') return { format, ...pdfToMarkdown(buf) };
  throw new RuleError(tr('只支持 Word（.docx）和 PDF；舊版 .doc 請先另存為 .docx'), 415, 'unsupported_format');
}

// ====================================================================== XML（Word 用）
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescapeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));

/** 很小的 XML 解析：返回根節點 { name, attrs, children }，文字節點是字串。 */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[6] !== undefined) top.children.push(unescapeXml(m[6]));
    else if (m[3]) {
      if (m[2] === '/') {
        while (stack.length > 1 && stack.pop().name !== m[3]) { /* 容錯：彈到對應標籤 */ }
      } else {
        const attrs = {};
        for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescapeXml(a[3] ?? a[4] ?? '');
        const node = { name: m[3], attrs, children: [] };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return root;
}

const kids = (n, name) => (n?.children || []).filter(c => typeof c === 'object' && (!name || c.name === name));
const kid = (n, name) => kids(n, name)[0] || null;
function find(n, name) {
  if (!n || typeof n !== 'object') return null;
  if (n.name === name) return n;
  for (const c of n.children) { const r = find(c, name); if (r) return r; }
  return null;
}
const textOf = n => (typeof n === 'string' ? n : (n?.children || []).map(textOf).join(''));
const on = el => !!el && !['0', 'false', 'off'].includes(String(el.attrs['w:val'] ?? 'true').toLowerCase());

// ====================================================================== Word
export function docxToMarkdown(buf) {
  let files;
  try {
    files = readZip(buf, { only: n => /^(word\/(document|styles|numbering)\.xml|word\/_rels\/document\.xml\.rels|docProps\/core\.xml)$/.test(n) });
  } catch (err) {
    throw new RuleError(tr('不是有效的 Word 文件（.docx）：{error}', { error: err.message }), 422, 'invalid_file');
  }
  const xml = name => (files.has(name) ? parseXml(files.get(name).toString('utf8')) : null);
  const doc = xml('word/document.xml');
  if (!doc) throw new RuleError(tr('不是有效的 Word 文件（.docx）：{error}', { error: 'word/document.xml' }), 422, 'invalid_file');
  const warnings = [];

  // 樣式：styleId → 標題級別（Title 為 0）
  const headingOf = new Map();
  const styles = xml('word/styles.xml');
  for (const s of kids(find(styles, 'w:styles'), 'w:style')) {
    const id = s.attrs['w:styleId'];
    const name = String(kid(s, 'w:name')?.attrs['w:val'] || '').toLowerCase();
    let level = null;
    if (name === 'title' || name === '標題' || id === 'Title') level = 0;
    else {
      const hm = /^(?:heading|標題|标题)\s*(\d)$/.exec(name) || /^Heading(\d)$/.exec(id || '');
      if (hm) level = Number(hm[1]);
      else {
        const ol = kid(kid(s, 'w:pPr'), 'w:outlineLvl');
        if (ol) level = Number(ol.attrs['w:val']) + 1;
      }
    }
    if (level !== null && level <= 9) headingOf.set(id, level);
  }

  // 編號：numId → ilvl → 是否有序
  const ordered = new Map();
  const numbering = xml('word/numbering.xml');
  const abstract = new Map();
  for (const a of kids(find(numbering, 'w:numbering'), 'w:abstractNum')) {
    const lv = new Map();
    for (const l of kids(a, 'w:lvl')) lv.set(l.attrs['w:ilvl'], (kid(l, 'w:numFmt')?.attrs['w:val'] || 'bullet') !== 'bullet');
    abstract.set(a.attrs['w:abstractNumId'], lv);
  }
  for (const n of kids(find(numbering, 'w:numbering'), 'w:num')) ordered.set(n.attrs['w:numId'], abstract.get(kid(n, 'w:abstractNumId')?.attrs['w:val']) || new Map());

  // 超鏈接
  const rels = new Map();
  for (const r of kids(find(xml('word/_rels/document.xml.rels'), 'Relationships'), 'Relationship')) rels.set(r.attrs.Id, r.attrs.Target);

  let images = 0;
  const runText = r => {
    let s = '';
    for (const c of kids(r)) {
      if (c.name === 'w:t') s += textOf(c);
      else if (c.name === 'w:tab') s += ' ';
      else if (c.name === 'w:br' || c.name === 'w:cr') s += ' ';
      else if (c.name === 'w:noBreakHyphen') s += '-';
      else if (c.name === 'w:drawing' || c.name === 'w:pict' || c.name === 'w:object') images++;
    }
    return s;
  };
  const inline = p => {
    const parts = [];
    const push = (text, rPr, href) => {
      if (!text) return;
      const b = on(kid(rPr, 'w:b'));
      const i = on(kid(rPr, 'w:i'));
      const last = parts[parts.length - 1];
      if (last && last.b === b && last.i === i && last.href === href) last.text += text;
      else parts.push({ text, b, i, href });
    };
    const walk = (node, href) => {
      for (const c of kids(node)) {
        if (c.name === 'w:r') push(runText(c), kid(c, 'w:rPr'), href);
        else if (c.name === 'w:hyperlink') {
          const target = c.attrs['r:id'] ? rels.get(c.attrs['r:id']) : null;
          walk(c, target && /^(https?:|mailto:)/i.test(target) ? target : href);
        } else if (['w:ins', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:fldSimple', 'w:customXml'].includes(c.name)) walk(c, href);
      }
    };
    walk(p, null);
    return parts.map(x => {
      const lead = x.text.match(/^\s*/)[0];
      const trail = x.text.match(/\s*$/)[0];
      let core = x.text.trim();
      if (!core) return x.text;
      if (x.b && x.i) core = `***${core}***`;
      else if (x.b) core = `**${core}**`;
      else if (x.i) core = `*${core}*`;
      if (x.href) core = `[${core}](${x.href})`;
      return lead + core + trail;
    }).join('').replace(/\s+/g, ' ').trim();
  };

  const blocks = [];
  const paragraph = p => {
    const pPr = kid(p, 'w:pPr');
    const style = kid(pPr, 'w:pStyle')?.attrs['w:val'];
    let level = style && headingOf.has(style) ? headingOf.get(style) : null;
    const ol = kid(pPr, 'w:outlineLvl');
    if (level === null && ol) level = Number(ol.attrs['w:val']) + 1;
    const text = inline(p);
    if (!text) return;
    const numPr = kid(pPr, 'w:numPr');
    if (level !== null && level <= 6) blocks.push({ type: 'heading', level, text: text.replace(/^\*+|\*+$/g, '') });
    else if (numPr) {
      const ilvl = kid(numPr, 'w:ilvl')?.attrs['w:val'] || '0';
      const numId = kid(numPr, 'w:numId')?.attrs['w:val'];
      if (numId === '0') blocks.push({ type: 'p', text });
      else blocks.push({ type: 'li', depth: Number(ilvl) || 0, ordered: !!ordered.get(numId)?.get(ilvl), text });
    } else blocks.push({ type: 'p', text });
  };
  const table = tbl => {
    const rows = kids(tbl, 'w:tr').map(tr => kids(tr, 'w:tc').map(tc => kids(tc, 'w:p').map(inline).filter(Boolean).join(' ').replace(/\|/g, '\\|')));
    if (rows.length) blocks.push({ type: 'table', rows });
  };
  const body = find(doc, 'w:body');
  const walkBody = node => {
    for (const c of kids(node)) {
      if (c.name === 'w:p') paragraph(c);
      else if (c.name === 'w:tbl') table(c);
      else if (c.name === 'w:sdt' || c.name === 'w:sdtContent' || c.name === 'w:customXml') walkBody(c);
    }
  };
  walkBody(body);
  if (images) warnings.push(tr('有 {n} 張圖片沒有導入：請在編輯器中用「插入圖片」重新上傳', { n: images }));

  // 標題：Title 樣式；沒有時，全文只有一個一級標題且在最前面，就用它
  let title = null;
  let shift = 1; // Heading 1 → ##
  const tIdx = blocks.findIndex(b => b.type === 'heading' && b.level === 0);
  if (tIdx >= 0) { title = blocks[tIdx].text; blocks.splice(tIdx, 1); }
  else {
    const h1 = blocks.filter(b => b.type === 'heading' && b.level === 1);
    if (h1.length === 1 && blocks[0] === h1[0]) { title = h1[0].text; blocks.shift(); shift = 0; }
  }
  if (!title) {
    const core = xml('docProps/core.xml');
    title = textOf(find(core, 'dc:title')).trim() || null;
  }
  return { title, body: renderBlocks(blocks, shift), warnings };
}

function renderBlocks(blocks, shift) {
  const out = [];
  let prev = null;
  let counters = [];
  for (const b of blocks) {
    if (b.type !== 'li') counters = [];
    if (b.type === 'heading') {
      const level = Math.min(6, Math.max(2, b.level + shift));
      out.push(`${prev ? '\n' : ''}${'#'.repeat(level)} ${b.text}\n`);
    } else if (b.type === 'li') {
      counters = counters.slice(0, b.depth + 1);
      counters[b.depth] = (counters[b.depth] || 0) + 1;
      out.push(`${prev && prev.type !== 'li' ? '\n' : ''}${'   '.repeat(b.depth)}${b.ordered ? `${counters[b.depth]}.` : '-'} ${b.text}`);
    } else if (b.type === 'table') {
      const width = Math.max(...b.rows.map(r => r.length));
      const pad = r => [...r, ...Array(width - r.length).fill('')];
      const lines = [`| ${pad(b.rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...b.rows.slice(1).map(r => `| ${pad(r).join(' | ')} |`)];
      out.push(`${prev ? '\n' : ''}${lines.join('\n')}\n`);
    } else {
      out.push(`${prev ? '\n' : ''}${b.text.replace(/^(#{1,6}\s|>\s?)/, '\\$1')}`);
    }
    prev = b;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ====================================================================== PDF
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map(c => c.charCodeAt(0)));

class PdfLexer {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.end = end; }
  skip() {
    const b = this.b;
    while (this.p < this.end) {
      const c = b[this.p];
      if (WS.has(c)) this.p++;
      else if (c === 37) { while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++; }
      else break;
    }
  }
  /** 讀一個值；遇到運算子（內容流）返回 { op }。 */
  value() {
    this.skip();
    const b = this.b;
    if (this.p >= this.end) return undefined;
    const c = b[this.p];
    if (c === 47) { // /Name
      let s = '';
      this.p++;
      while (this.p < this.end && !WS.has(b[this.p]) && !DELIM.has(b[this.p])) {
        if (b[this.p] === 35 && this.p + 2 < this.end) { s += String.fromCharCode(parseInt(b.subarray(this.p + 1, this.p + 3).toString('latin1'), 16)); this.p += 3; }
        else s += String.fromCharCode(b[this.p++]);
      }
      return { name: s };
    }
    if (c === 40) return { str: this.literal() };
    if (c === 60) {
      if (b[this.p + 1] === 60) { this.p += 2; return this.dict(); }
      this.p++;
      let hex = '';
      while (this.p < this.end && b[this.p] !== 62) { const ch = b[this.p++]; if (!WS.has(ch)) hex += String.fromCharCode(ch); }
      this.p++;
      if (hex.length % 2) hex += '0';
      return { str: Buffer.from(hex, 'hex') };
    }
    if (c === 91) {
      this.p++;
      const arr = [];
      for (;;) {
        this.skip();
        if (this.p >= this.end) break;
        if (b[this.p] === 93) { this.p++; break; }
        const v = this.value();
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (c === 62 && b[this.p + 1] === 62) { this.p += 2; return { op: '>>' }; }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const start = this.p;
      this.p++;
      while (this.p < this.end && ((b[this.p] >= 48 && b[this.p] <= 57) || b[this.p] === 46)) this.p++;
      const n = Number(b.subarray(start, this.p).toString('latin1'));
      // 間接引用：n g R
      const save = this.p;
      const m = /^\s+(\d+)\s+R(?![A-Za-z])/.exec(b.subarray(this.p, Math.min(this.end, this.p + 24)).toString('latin1'));
      if (m && Number.isInteger(n)) { this.p = save + m[0].length; return { ref: n }; }
      return Number.isFinite(n) ? n : 0;
    }
    // 運算子或關鍵字
    const start = this.p;
    while (this.p < this.end && !WS.has(b[this.p]) && !DELIM.has(b[this.p])) this.p++;
    if (this.p === start) { this.p++; return { op: String.fromCharCode(c) }; }
    const word = b.subarray(start, this.p).toString('latin1');
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { op: word };
  }
  dict() {
    const d = {};
    for (;;) {
      this.skip();
      if (this.p >= this.end) break;
      if (this.b[this.p] === 62 && this.b[this.p + 1] === 62) { this.p += 2; break; }
      const k = this.value();
      if (!k || k.name === undefined) { if (k?.op === '>>') break; continue; }
      d[k.name] = this.value();
    }
    return { dict: d };
  }
  literal() {
    const b = this.b;
    this.p++;
    const out = [];
    let depth = 1;
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 92) {
        const n = b[this.p++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[n] !== undefined) out.push(map[n]);
        else if (n >= 48 && n <= 55) {
          let oct = String.fromCharCode(n);
          for (let i = 0; i < 2 && b[this.p] >= 48 && b[this.p] <= 55; i++) oct += String.fromCharCode(b[this.p++]);
          out.push(parseInt(oct, 8) & 0xff);
        } else if (n === 13) { if (b[this.p] === 10) this.p++; } else if (n !== 10) out.push(n);
      } else if (c === 40) { depth++; out.push(c); } else if (c === 41) { if (--depth === 0) break; out.push(c); } else out.push(c);
    }
    return Buffer.from(out);
  }
}

function ascii85(buf) {
  const s = buf.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  let group = [];
  const flush = (g, n) => {
    let v = 0;
    for (const ch of g) v = v * 85 + (ch - 33);
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n));
  };
  for (const ch of s) {
    if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0));
    if (group.length === 5) { flush(group, 4); group = []; }
  }
  if (group.length) { const n = group.length - 1; while (group.length < 5) group.push(117); flush(group, n); }
  return Buffer.from(out);
}

export function pdfToMarkdown(buf) {
  const pdf = new PdfDoc(buf);
  const pages = pdf.pages();
  if (!pages.length) throw new RuleError(tr('PDF 裡沒有找到頁面'), 422, 'invalid_file');
  const lines = [];
  const warnings = [];
  let skippedFonts = 0;
  pages.forEach((page, pi) => {
    const runs = [];
    try { pdf.textRuns(page, runs); } catch (err) { warnings.push(tr('第 {n} 頁讀取失敗：{error}', { n: pi + 1, error: err.message })); }
    skippedFonts += runs.filter(r => r.undecodable).length;
    for (const l of assembleLines(runs.filter(r => !r.undecodable && r.text))) lines.push({ ...l, page: pi });
  });
  const text = lines.map(l => l.text).join('');
  if (!text.trim()) throw new RuleError(tr('PDF 沒有可以提取的文字（可能是掃描件）；請用帶文字層的 PDF，或先做文字識別'), 422, 'no_text');
  if (skippedFonts) warnings.push(tr('有 {n} 段文字的字體沒有對照表，無法還原，已略過', { n: skippedFonts }));
  return { ...linesToMarkdown(lines), warnings };
}

class PdfDoc {
  constructor(buf) {
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new RuleError(tr('不是有效的 PDF 文件'), 422, 'invalid_file');
    this.buf = buf;
    this.objects = new Map();
    const s = buf.toString('latin1');
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const start = m.index + m[0].length;
      try {
        const lx = new PdfLexer(buf, start);
        const value = lx.value();
        let stream = null;
        lx.skip();
        if (value?.dict && s.startsWith('stream', lx.p)) {
          let p = lx.p + 6;
          if (buf[p] === 13) p++;
          if (buf[p] === 10) p++;
          let len = value.dict.Length;
          if (len?.ref !== undefined) len = null; // 長度是間接引用時先按 endstream 找，之後再修正
          let end = typeof len === 'number' && s.startsWith('endstream', skipWs(s, p + len)) ? p + len : s.indexOf('endstream', p);
          if (end < 0) end = buf.length;
          stream = { start: p, end, lengthRef: value.dict.Length?.ref };
          re.lastIndex = end;
        }
        this.objects.set(num, { value, stream });
      } catch { /* 單個物件壞了不影響其他物件 */ }
    }
    if (/\/Encrypt\s/.test(s.slice(Math.max(0, s.lastIndexOf('trailer') - 10))) || [...this.objects.values()].some(o => o.value?.dict?.Encrypt)) throw new RuleError(tr('PDF 已加密，不能導入；請先解除密碼保護'), 422, 'encrypted');
    // 物件流（PDF 1.5+）
    for (const [, o] of [...this.objects]) {
      if (o.value?.dict?.Type?.name !== 'ObjStm' || !o.stream) continue;
      try {
        const data = this.streamData(o);
        const n = Number(o.value.dict.N) || 0;
        const first = Number(o.value.dict.First) || 0;
        const head = new PdfLexer(data, 0, first);
        const pairs = [];
        for (let i = 0; i < n; i++) pairs.push([head.value(), head.value()]);
        for (const [num, off] of pairs) if (typeof num === 'number' && !this.objects.has(num)) this.objects.set(num, { value: new PdfLexer(data, first + off).value(), stream: null });
      } catch { /* 忽略壞掉的物件流 */ }
    }
  }

  get(v) {
    let guard = 0;
    while (v && v.ref !== undefined && guard++ < 20) v = this.objects.get(v.ref)?.value;
    return v;
  }
  obj(v) { return v && v.ref !== undefined ? this.objects.get(v.ref) : null; }

  streamData(o) {
    if (!o?.stream) return Buffer.alloc(0);
    let { start, end } = o.stream;
    if (o.stream.lengthRef !== undefined) {
      const len = this.get({ ref: o.stream.lengthRef });
      if (typeof len === 'number' && start + len <= this.buf.length) end = start + len;
    }
    let data = this.buf.subarray(start, end);
    const d = o.value.dict;
    let filters = this.get(d.Filter);
    filters = Array.isArray(filters) ? filters.map(f => this.get(f)) : filters ? [filters] : [];
    for (const f of filters) {
      const name = f?.name;
      if (name === 'FlateDecode' || name === 'Fl') {
        try { data = zlib.inflateSync(data); } catch { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') data = Buffer.from(data.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex');
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else return Buffer.alloc(0); // 圖片等其他編碼與文字無關
    }
    return data;
  }

  pages() {
    const catalog = [...this.objects.values()].find(o => o.value?.dict?.Type?.name === 'Catalog');
    const out = [];
    const seen = new Set();
    const walk = (node, inherited) => {
      const n = this.get(node);
      if (!n?.dict || out.length > 2000) return;
      const key = node?.ref;
      if (key !== undefined) { if (seen.has(key)) return; seen.add(key); }
      const res = n.dict.Resources ? this.get(n.dict.Resources) : inherited;
      if (n.dict.Type?.name === 'Page' || (!n.dict.Kids && n.dict.Contents)) out.push({ dict: n.dict, resources: res });
      else for (const k of this.get(n.dict.Kids) || []) walk(k, res);
    };
    if (catalog) walk(catalog.value.dict.Pages, null);
    if (!out.length) for (const o of this.objects.values()) if (o.value?.dict?.Type?.name === 'Page') out.push({ dict: o.value.dict, resources: this.get(o.value.dict.Resources) });
    return out;
  }

  font(ref) {
    this.fontCache ||= new Map();
    const key = ref?.ref ?? ref;
    if (this.fontCache.has(key)) return this.fontCache.get(key);
    const f = this.get(ref)?.dict || {};
    const font = { twoByte: false, map: null, widths: new Map(), dw: 1000, simple: true, undecodable: false };
    const sub = this.get(f.Subtype)?.name;
    if (sub === 'Type0') {
      font.simple = false;
      font.twoByte = true;
      const desc = this.get((this.get(f.DescendantFonts) || [])[0])?.dict || {};
      font.dw = Number(this.get(desc.DW)) || 1000;
      const w = this.get(desc.W) || [];
      for (let i = 0; i < w.length;) {
        const a = this.get(w[i]);
        const b = this.get(w[i + 1]);
        if (Array.isArray(b)) { b.forEach((x, j) => font.widths.set(a + j, Number(this.get(x)) || font.dw)); i += 2; }
        else { const ww = Number(this.get(w[i + 2])) || font.dw; for (let c = a; c <= b && c - a < 65536; c++) font.widths.set(c, ww); i += 3; }
      }
    } else {
      const first = Number(this.get(f.FirstChar)) || 0;
      (this.get(f.Widths) || []).forEach((x, j) => font.widths.set(first + j, Number(this.get(x)) || 0));
      font.dw = 500;
      const enc = this.get(f.Encoding);
      font.differences = new Map();
      const diffs = enc?.dict ? this.get(enc.dict.Differences) : null;
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const d of diffs.map(x => this.get(x))) { if (typeof d === 'number') code = d; else if (d?.name) font.differences.set(code++, d.name); }
      }
    }
    const tu = this.obj(f.ToUnicode);
    if (tu) {
      const cmap = parseCMap(this.streamData(tu).toString('latin1'));
      font.map = cmap.map;
      if (cmap.bytes) font.twoByte = cmap.bytes === 2;
    } else if (!font.simple) font.undecodable = true;
    this.fontCache.set(key, font);
    return font;
  }

  /** 把一頁的文字片段（位置、字號、文字）收集到 runs。 */
  textRuns(page, runs) {
    const contents = this.get(page.dict.Contents);
    const parts = (Array.isArray(contents) ? contents : [page.dict.Contents]).map(c => this.streamData(this.obj(c) || { stream: null }));
    this.runContent(Buffer.concat(parts.flatMap(p => [p, Buffer.from('\n')])), page.resources, [1, 0, 0, 1, 0, 0], runs, 0);
  }

  runContent(data, resources, baseCtm, runs, depth) {
    if (depth > 4) return;
    const res = this.get(resources)?.dict || {};
    const fonts = this.get(res.Font)?.dict || {};
    const xobjects = this.get(res.XObject)?.dict || {};
    const lx = new PdfLexer(data);
    const ops = [];
    let ctm = baseCtm;
    const stack = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = tm;
    let font = null;
    let size = 12;
    let leading = 0;
    let tc = 0;
    let tw = 0;
    let th = 1;
    const show = bytes => {
      if (!font || !bytes) return;
      const m = mul(tm, ctm);
      const scale = Math.hypot(m[2], m[3]) || 1;
      const { text, advance } = decode(font, bytes, size, tc, tw, th);
      runs.push({ x: m[4], y: m[5], size: size * scale, text, undecodable: font.undecodable, width: advance * Math.hypot(m[0], m[1]) });
      tm = mul([1, 0, 0, 1, advance, 0], tm);
    };
    for (;;) {
      const v = lx.value();
      if (v === undefined) break;
      if (!v || v.op === undefined || v.op === '>>') { ops.push(v); continue; }
      const op = v.op;
      const a = ops.splice(0);
      const num = i => Number(a[i]) || 0;
      switch (op) {
        case 'q': stack.push(ctm); break;
        case 'Q': ctm = stack.pop() || baseCtm; break;
        case 'cm': ctm = mul(a.slice(0, 6).map(Number), ctm); break;
        case 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'Tf': font = this.font(fonts[a[0]?.name]); size = num(1) || size; break;
        case 'Tc': tc = num(0); break;
        case 'Tw': tw = num(0); break;
        case 'Tz': th = num(0) / 100 || 1; break;
        case 'TL': leading = num(0); break;
        case 'Td': tm = tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); break;
        case 'TD': leading = -num(1); tm = tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); break;
        case 'Tm': tm = tlm = a.slice(0, 6).map(Number); break;
        case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); break;
        case 'Tj': show(a[0]?.str); break;
        case "'": tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); show(a[0]?.str); break;
        case '"': tw = num(0); tc = num(1); tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); show(a[2]?.str); break;
        case 'TJ':
          for (const el of Array.isArray(a[0]) ? a[0] : []) {
            if (el?.str) show(el.str);
            else if (typeof el === 'number') {
              const dx = (-el / 1000) * size * th;
              if (el < -180 && font) { const m = mul(tm, ctm); runs.push({ x: m[4], y: m[5], size: size * (Math.hypot(m[2], m[3]) || 1), text: ' ', space: true }); }
              tm = mul([1, 0, 0, 1, dx, 0], tm);
            }
          }
          break;
        case 'Do': {
          const xo = this.obj(xobjects[a[0]?.name]);
          if (xo?.value?.dict?.Subtype?.name === 'Form') {
            const fm = this.get(xo.value.dict.Matrix);
            this.runContent(this.streamData(xo), xo.value.dict.Resources || resources, Array.isArray(fm) ? mul(fm.map(x => Number(this.get(x))), ctm) : ctm, runs, depth + 1);
          }
          break;
        }
        case 'BI': { // 內嵌圖片：跳到 EI
          const s = data.toString('latin1');
          const end = s.indexOf('EI', lx.p);
          lx.p = end < 0 ? data.length : end + 2;
          break;
        }
        default: break;
      }
    }
  }
}

const skipWs = (s, p) => { while (p < s.length && /\s/.test(s[p])) p++; return p; };
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

/** ToUnicode 對照表：bfchar、bfrange。返回 { map: Map<code, string>, bytes }。 */
export function parseCMap(text) {
  const map = new Map();
  const hex = h => Buffer.from(h.length % 2 ? `${h}0` : h, 'hex');
  const uni = h => { const b = hex(h); let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; };
  let bytes = 0;
  const cs = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(text);
  if (cs) bytes = cs[1].length / 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) { map.set(parseInt(m[1], 16), uni(m[2])); bytes ||= m[1].length / 2; }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      bytes ||= m[1].length / 2;
      if (hi - lo > 65535) continue;
      if (m[4] !== undefined) {
        const base = hex(m[4]);
        for (let c = lo; c <= hi; c++) {
          const b = Buffer.from(base);
          b.writeUInt16BE((b.readUInt16BE(b.length - 2) + (c - lo)) & 0xffff, b.length - 2);
          let s = '';
          for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
          map.set(c, s);
        }
      } else {
        const list = [...m[5].matchAll(/<([0-9a-f]*)>/gi)].map(x => uni(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      }
    }
  }
  return { map, bytes };
}

const GLYPHS = { space: ' ', hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•', parenleft: '(', parenright: ')', slash: '/', fi: 'fi', fl: 'fl' };

function decode(font, bytes, size, tc, tw, th) {
  let text = '';
  let adv = 0;
  const step = font.twoByte ? 2 : 1;
  for (let i = 0; i + step - 1 < bytes.length; i += step) {
    const code = step === 2 ? bytes.readUInt16BE(i) : bytes[i];
    let ch;
    if (font.map?.has(code)) ch = font.map.get(code);
    else if (font.differences?.has(code)) { const g = font.differences.get(code); ch = GLYPHS[g] || (/^uni([0-9A-F]{4})$/.test(g) ? String.fromCharCode(parseInt(g.slice(3), 16)) : g.length === 1 ? g : ''); }
    else ch = font.twoByte ? '' : String.fromCharCode(code);
    text += ch;
    const w = font.widths.has(code) ? font.widths.get(code) : font.dw;
    adv += ((w / 1000) * size + tc + (ch === ' ' && step === 1 ? tw : 0)) * th;
  }
  return { text: text.replace(/\u0000/g, ''), advance: adv };
}

const CJK_RE = /[⺀-鿿豈-﫿＀-￯]/;

/** 按 y 坐標聚成行，按 x 排序；片段之間空隙大於半個字寬時補空格（中文之間不補）。 */
function assembleLines(runs) {
  const lines = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    const tol = Math.max(1, r.size * 0.45);
    if (last && Math.abs(last.y - r.y) <= tol) last.runs.push(r);
    else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  return lines.map(l => {
    const rs = l.runs.filter(r => !r.space || true).sort((a, b) => a.x - b.x);
    let text = '';
    let endX = null;
    let maxSize = 0;
    for (const r of rs) {
      if (r.space) { if (text && !text.endsWith(' ')) text += ' '; continue; }
      if (endX !== null && r.x - endX > r.size * 0.25 && text && !text.endsWith(' ')) {
        const prev = text[text.length - 1];
        if (!(CJK_RE.test(prev) && CJK_RE.test(r.text[0] || ''))) text += ' ';
      }
      text += r.text;
      endX = r.x + (r.width || r.text.length * r.size * 0.5);
      if (r.text.trim()) maxSize = Math.max(maxSize, r.size);
    }
    const first = rs.find(r => !r.space && r.text.trim());
    return { y: l.y, x: first ? first.x : 0, endX: endX ?? 0, size: maxSize || l.size, text: text.replace(/\s+/g, ' ').trim() };
  }).filter(l => l.text);
}

const BULLET_RE = /^([•●▪◦○■□\-–·])\s*/;

function linesToMarkdown(lines) {
  if (!lines.length) return { title: null, body: '' };
  // 正文字號：按字數加權的眾數
  const weight = new Map();
  for (const l of lines) { const k = Math.round(l.size * 2) / 2; weight.set(k, (weight.get(k) || 0) + l.text.length); }
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const bigger = [...new Set(lines.map(l => Math.round(l.size * 2) / 2).filter(s => s >= body * 1.15))].sort((a, b) => b - a);
  // 左邊界（按行數的眾數）與右邊界：縮進的短行視為清單項（有些生成器把項目符號畫成圖形，不是文字）
  const lefts = new Map();
  for (const l of lines) { const k = Math.round(l.x); lefts.set(k, (lefts.get(k) || 0) + 1); }
  const left = [...lefts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const right = Math.max(...lines.map(l => l.endX));
  const indented = l => l.x - left > l.size * 1.2;
  let title = null;
  const out = [];
  let para = '';
  let prev = null;
  const flush = () => { if (para) { out.push(para); para = ''; } };
  lines.forEach((l, i) => {
    const sz = Math.round(l.size * 2) / 2;
    const rank = bigger.indexOf(sz);
    const short = l.text.length <= 60;
    if (rank >= 0 && short) {
      flush();
      if (!title && i <= 2 && l.page === 0 && rank === 0) title = l.text;
      else out.push(`${rank === 0 && title ? '##' : rank <= 1 ? '##' : '###'} ${l.text}`);
      prev = l;
      return;
    }
    const bullet = BULLET_RE.exec(l.text);
    const numbered = /^(\d{1,2})[.、)]\s*/.exec(l.text);
    const gap = prev && prev.page === l.page ? Math.abs(prev.y - l.y) : Infinity;
    const newPara = !prev || gap > l.size * 1.9 || prev.page !== l.page && /[。.!?！？：:]$/.test(para) || bullet || numbered;
    if (bullet) { flush(); out.push(`- ${l.text.slice(bullet[0].length)}`); prev = l; return; }
    if (indented(l) && !numbered && (!prev || !indented(prev) || prev.endX < right - l.size * 2 || gap > l.size * 1.9)) { flush(); out.push(`- ${l.text}`); prev = l; return; }
    if (numbered) { flush(); out.push(`${numbered[1]}. ${l.text.slice(numbered[0].length)}`); prev = l; return; }
    if (newPara) flush();
    else if (para && !(CJK_RE.test(para[para.length - 1]) && CJK_RE.test(l.text[0]))) para += ' ';
    // 清單項的續行
    if (!newPara && !para && out.length && /^(-|\d+\.) /.test(out[out.length - 1])) { out[out.length - 1] += (CJK_RE.test(l.text[0]) ? '' : ' ') + l.text; prev = l; return; }
    para += l.text;
    prev = l;
  });
  flush();
  // 塊之間空行；連續的清單項之間不空行
  const md = [];
  for (const b of out) {
    const prevB = md[md.length - 1];
    const isList = /^(-|\d+\.) /.test(b);
    if (prevB !== undefined && !(isList && /^(-|\d+\.) /.test(prevB))) md.push('');
    md.push(b);
  }
  return { title, body: `${md.join('\n').trim()}\n` };
}
