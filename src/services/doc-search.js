// 文檔搜索（設計文件 §10.4）：標題、摘要、標籤、欄位、章節標題、正文按權重遞減；
// 中文按單字與雙字詞、英文按單詞匹配；查詢中的術語先經 resolveTerms 解析為規範主體，關聯了該主體的文檔加權；
// 結果帶最匹配的章節（錨點與摘錄）。索引按文檔 etag 快取在記憶體中。
import { parseSections, REF_RE } from '../../web/assets/markdown.js';

const CJK = /[㐀-鿿豈-﫿]/;
const STOP = new Set([...'的了是在有和與与及或也都就還还會会能要把被從从到對对為为於于個个這这那哪些麼么樣样何請请問问嗎吗呢吧啊']);
const WEIGHTS = { title: 10, summary: 6, tags: 5, fields: 4, headings: 3, body: 1 };

/** 分詞：拉丁字母按單詞（小寫），中文按單字與相鄰雙字。返回 { key: 關鍵詞（雙字、單詞）, all: 全部 }。 */
export function tokenize(text) {
  const all = new Set();
  const key = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g)) {
    all.add(m[0]);
    key.push(m[0]);
  }
  let run = [];
  const flush = () => {
    for (let i = 0; i < run.length; i++) {
      all.add(run[i]);
      if (i + 1 < run.length) { all.add(run[i] + run[i + 1]); key.push(run[i] + run[i + 1]); }
    }
    if (run.length === 1) key.push(run[0]);
    run = [];
  };
  for (const ch of s) {
    if (CJK.test(ch) && !STOP.has(ch)) run.push(ch);
    else flush();
  }
  flush();
  return { key: [...new Set(key)], all };
}

const setOf = text => tokenize(text).all;

export class DocSearch {
  constructor(lib) {
    this.lib = lib;
    this.cache = new Map();
    this.lastResolved = null;
  }

  clear() { this.cache.clear(); }
  invalidate(id) { this.cache.delete(id); }

  index(doc, side) {
    const e = side === 'draft' ? doc.draft : doc.pub;
    const key = `${doc.id}:${side}`;
    const hit = this.cache.get(key);
    if (hit && hit.etag === e.etag && hit.etag) return hit.idx;
    const st = this.lib.store;
    const m = e.meta;
    const tpl = this.lib.templates.get(m.template);
    const fieldText = [tpl?.name, ...Object.values(m.fields || {}).flat().map(v => {
      const s = typeof v === 'string' ? st.subjects.get(v) || st.objects.get(v) : null;
      return s ? `${v} ${s.name}` : String(v);
    })].join(' ');
    const sections = parseSections(e.body).map(s => ({ anchor: s.anchor, heading: s.heading, path: s.path, text: s.text, head: setOf(s.heading), body: setOf(s.text) }));
    const idx = {
      title: setOf(`${m.title} ${doc.id}`), summary: setOf(m.summary), tags: setOf(m.tags.join(' ')), fields: setOf(fieldText),
      headings: setOf(sections.map(s => s.heading).join(' ')), body: setOf(e.body), sections,
      subjects: new Set([...m.subjects, ...Object.values(m.fields || {}).flat().filter(v => typeof v === 'string' && v.startsWith('S-'))])
    };
    this.cache.set(key, { etag: e.etag, idx });
    return idx;
  }

  /** entries：[{ doc, side }]。返回 { hits: [{ doc, side, score, match }], terms }。 */
  search(entries, q) {
    const st = this.lib.store;
    const resolved = st.resolveTerms(q);
    // 每個被解析的術語：關聯了它指向的主體，就算這個術語命中
    const units = resolved.matches.map(m => {
      const s = st.subjects.get(m.id);
      const targets = s?.type === '別名' ? st.aliasTargets(s) : [m.id];
      return { text: m.term, tokens: tokenize(m.term).key, subjects: targets };
    });
    const { key } = tokenize(q);
    const terms = key.length ? key : [...tokenize(q).all];
    this.lastResolved = { canonical: resolved.canonical, ambiguous: resolved.ambiguous.map(a => ({ term: a.term, candidates: a.candidates.map(c => c.id) })) };
    if (!terms.length && !units.length) return { hits: [], terms: [] };
    const hits = [];
    for (const { doc, side } of entries) {
      const idx = this.index(doc, side);
      let score = 0;
      const covered = new Set();
      for (const tk of terms) {
        let best = 0;
        for (const [f, w] of Object.entries(WEIGHTS)) if (idx[f].has(tk) && w > best) best = w;
        if (best) { score += best * (tk.length > 1 ? 1 : 0.4); covered.add(tk); }
      }
      for (const u of units) {
        if (u.subjects.some(sid => idx.subjects.has(sid))) {
          score += 8;
          for (const tk of u.tokens) covered.add(tk);
        }
      }
      if (!score) continue;
      const coverage = covered.size / terms.length;
      if (terms.length > 1 && coverage < 0.6) continue;
      // 最匹配的章節
      let match = null;
      let bestScore = 0;
      for (const s of idx.sections) {
        let sc = 0;
        for (const tk of terms) {
          if (s.head.has(tk)) sc += 3;
          if (s.body.has(tk)) sc += 1;
        }
        // 解析出的術語：章節提到它指向的主體（名稱或 ID）也算命中
        for (const u of units) if (u.subjects.some(sid => s.text.includes(sid) || (st.subjects.get(sid)?.name && s.text.includes(st.subjects.get(sid).name)))) sc += 1;
        if (sc > bestScore) { bestScore = sc; match = s; }
      }
      hits.push({ doc, side, score: Math.round(score * 10) / 10, match: match ? { anchor: match.anchor, heading: match.heading, path: match.path, snippet: snippet(plainDocText(st, match.text) || match.heading, terms) } : null });
    }
    hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
    return { hits, terms };
  }

  /** 段級搜索（GET /doc-sections）：每個命中的章節一條。 */
  sections(entries, q, limit = 20) {
    const { key } = tokenize(q);
    const terms = key.length ? key : [...tokenize(q).all];
    const st = this.lib.store;
    const resolved = st.resolveTerms(q);
    const subjectIds = new Set(resolved.canonical);
    const out = [];
    for (const { doc, side } of entries) {
      const idx = this.index(doc, side);
      const linkBonus = [...subjectIds].some(id => idx.subjects.has(id)) ? 2 : 0;
      const titleHit = terms.filter(tk => idx.title.has(tk)).length;
      for (const s of idx.sections) {
        let sc = 0;
        let matched = 0;
        for (const tk of terms) {
          const h = s.head.has(tk);
          const b = s.body.has(tk);
          if (h || b || idx.title.has(tk)) matched++;
          sc += (h ? 3 : 0) + (b ? 1 : 0);
        }
        if (!sc && !linkBonus) continue;
        if (terms.length > 1 && matched / terms.length < 0.6 && !linkBonus) continue;
        out.push({ doc, side, section: s, score: sc + linkBonus + titleHit * 0.5 });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return { hits: out.slice(0, limit).map(h => ({ ...h, snippet: snippet(plainDocText(st, h.section.text) || h.section.heading, terms) })), terms };
  }
}

/** 摘錄用的純文字：[[ID]] 換成名稱，去掉代碼塊圍欄、列表符號和行內標記。 */
export function plainDocText(store, text) {
  return String(text || '')
    .replace(REF_RE, (all, id) => store.subjects.get(id)?.name || store.objects.get(id)?.name || id)
    .replace(/```[\w-]*|~~~/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ').replace(/\|/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 取包含查詢詞的一段摘錄（前後約 40 字）。 */
export function snippet(text, terms, width = 40) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = s.toLowerCase();
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  let at = -1;
  for (const tk of sorted) { at = lower.indexOf(tk); if (at >= 0) break; }
  if (at < 0) return s.slice(0, width * 2) + (s.length > width * 2 ? '…' : '');
  const start = Math.max(0, at - width);
  const end = Math.min(s.length, at + width);
  return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`;
}
