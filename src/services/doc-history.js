// 文檔的版本歷史與差異（設計文件 §6.3）：版本來自已發布檔案的 git log --follow，不另存版本表。
// 每個提交讀出當時的 front matter，按 version 與 change 區分「發布」與移動、改標題、改標籤、確認複審、在 Git 中直接修改等整理事件。
import path from 'node:path';
import { parseDocFile, folderOfPath } from '../store/docs.js';
import { parseSections } from '../../web/assets/markdown.js';
import { RuleError } from '../store/validity.js';
import { tr } from '../i18n/index.js';

const sameList = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export async function docHistory(lib, doc, { limit = 100 } = {}) {
  const st = lib.store;
  if (!doc.pub) return { events: [], versions: [] };
  const file = path.posix.join(st.subdir, doc.pub.path);
  const log = await st.repo.logFile(file, { limit });
  const prefix = `${st.subdir}/`;
  const commits = log.filter(c => c.path && c.change !== 'D' && c.path.startsWith(prefix) && !c.path.startsWith(`${prefix}docs/_drafts/`)).reverse();
  const events = [];
  let prev = null;
  for (const c of commits) {
    let parsed;
    try { parsed = parseDocFile(await st.repo.show(c.hash, c.path)); } catch { continue; }
    const m = parsed.meta || {};
    if (m.id && m.id !== doc.id) continue;
    const rel = c.path.slice(prefix.length);
    const folder = folderOfPath(rel);
    const ev = { hash: c.hash, date: c.date, author: c.author, email: c.email, subject: c.subject, path: rel, folder, title: m.title, version: m.version ?? null };
    const pm = prev?.meta;
    if (!prev || (Number(m.version) || 0) > (Number(pm.version) || 0)) Object.assign(ev, { type: 'publish', major: !!m.change?.major, note: m.change?.note || null, publishedBy: m.change?.publishedBy || null, selfApproved: !!m.change?.selfApproved, fromGit: !!m.change?.fromGit });
    else if (m.status === '已廢止' && pm.status !== '已廢止') Object.assign(ev, { type: 'obsolete', reason: m.obsoleteReason || null, replacedBy: m.replacedBy || null });
    else if (prev.folder !== folder) Object.assign(ev, { type: 'move', from: prev.folder, to: folder });
    else if (pm.title !== m.title) Object.assign(ev, { type: 'rename', from: pm.title, to: m.title });
    else if (!sameList(pm.tags, m.tags)) Object.assign(ev, { type: 'tags', added: (m.tags || []).filter(x => !(pm.tags || []).includes(x)), removed: (pm.tags || []).filter(x => !(m.tags || []).includes(x)) });
    else if ((pm.review?.lastAt || null) !== (m.review?.lastAt || null)) Object.assign(ev, { type: 'review', nextAt: m.review?.nextAt || null });
    else if (prev.body !== parsed.body) Object.assign(ev, { type: 'git_edit' });
    else Object.assign(ev, { type: 'organize' });
    events.push(ev);
    prev = { meta: m, body: parsed.body, folder };
  }
  events.reverse();
  return {
    events,
    versions: events.filter(e => e.type === 'publish').map(e => ({ version: e.version, hash: e.hash, date: e.date, major: e.major, note: e.note, publishedBy: e.publishedBy })),
    editedInGit: events[0]?.type === 'git_edit'
  };
}

/** 讀某個版本：當前版本直接取記憶體，其他版本從 Git 歷史讀出。 */
export async function readVersion(lib, doc, version) {
  const v = Number(version);
  if (doc.pub && Number(doc.pub.meta.version) === v) return { meta: doc.pub.meta, body: doc.pub.body, path: doc.pub.path, hash: null, version: v };
  const { versions, events } = await docHistory(lib, doc);
  const hit = versions.find(x => Number(x.version) === v);
  if (!hit) throw new RuleError(tr('{id} 沒有版本 v{version}', { id: doc.id, version }), 404, 'not_found');
  const ev = events.find(e => e.hash === hit.hash);
  const parsed = parseDocFile(await lib.store.repo.show(hit.hash, path.posix.join(lib.store.subdir, ev.path)));
  return { meta: parsed.meta, body: parsed.body, path: ev.path, hash: hit.hash, version: v };
}

// ---------------------------------------------------------------- 差異
/** Myers 逐行差異：返回 [{ op: ' '|'-'|'+', text, a, b }]（a、b 為兩邊的行號，從 1 起算）。 */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length;
  let eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(pre, ea);
  const B = b.slice(pre, eb);
  const mid = myers(A, B);
  const out = [];
  for (let i = 0; i < pre; i++) out.push({ op: ' ', text: a[i], a: i + 1, b: i + 1 });
  for (const x of mid) out.push({ op: x.op, text: x.op === '+' ? B[x.j] : A[x.i], a: x.op === '+' ? null : pre + x.i + 1, b: x.op === '-' ? null : pre + x.j + 1 });
  for (let i = 0; i < a.length - ea; i++) out.push({ op: ' ', text: a[ea + i], a: ea + i + 1, b: eb + i + 1 });
  return out;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((_, j) => ({ op: '+', j }));
  if (!m) return a.map((_, i) => ({ op: '-', i }));
  const max = n + m;
  if (max > 40000) return [...a.map((_, i) => ({ op: '-', i })), ...b.map((_, j) => ({ op: '+', j }))];
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? v[k + 1 + off] : v[k - 1 + off] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + off] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
    if (d > 3000) return [...a.map((_, i) => ({ op: '-', i })), ...b.map((_, j) => ({ op: '+', j }))];
  }
  const out = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? k + 1 : k - 1;
    const prevX = v[prevK + off];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ op: ' ', i: x - 1, j: y - 1 }); x--; y--; }
    if (d > 0) {
      if (x === prevX) out.push({ op: '+', j: y - 1 });
      else out.push({ op: '-', i: x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse().filter(o => o.op !== ' ');
}

/** 逐行差異分塊：每塊前後保留 context 行上下文。 */
export function hunks(lines, context = 3) {
  const out = [];
  let cur = null;
  let lastChange = -Infinity;
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    const start = Math.max(0, i - context);
    if (!cur || start > lastChange + context + 1) {
      if (cur) out.push(cur);
      cur = { lines: lines.slice(start, i) };
    } else cur.lines.push(...lines.slice(lastChange + 1, i));
    cur.lines.push(l);
    lastChange = i;
  });
  if (cur) {
    cur.lines.push(...lines.slice(lastChange + 1, lastChange + 1 + context));
    out.push(cur);
  }
  return out.map(h => {
    const a = h.lines.find(l => l.a)?.a || 0;
    const b = h.lines.find(l => l.b)?.b || 0;
    return { header: `@@ -${a},${h.lines.filter(l => l.op !== '+').length} +${b},${h.lines.filter(l => l.op !== '-').length} @@`, lines: h.lines };
  });
}

/** 兩個版本的差異：欄位與元資料的變化、按章節的增刪改、逐行差異。 */
export function compareDocs(from, to) {
  const metaKeys = ['title', 'summary', 'tags', 'owner', 'subjects', 'objects', 'related'];
  // 空值、空字串、空陣列都視為「沒有」，避免舊版缺欄位被當成變化。
  const norm = v => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? null : v);
  const meta = [];
  for (const k of metaKeys) {
    const a = norm(from.meta?.[k]);
    const b = norm(to.meta?.[k]);
    if (JSON.stringify(a) !== JSON.stringify(b)) meta.push({ key: k, from: a, to: b });
  }
  const fields = [];
  const fa = from.meta?.fields || {};
  const fb = to.meta?.fields || {};
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) if (JSON.stringify(norm(fa[k])) !== JSON.stringify(norm(fb[k]))) fields.push({ key: k, from: norm(fa[k]), to: norm(fb[k]) });
  const sa = parseSections(from.body);
  const sb = parseSections(to.body);
  const byAnchor = new Map(sa.map(s => [s.anchor, s]));
  const sections = [];
  for (const s of sb) {
    const old = byAnchor.get(s.anchor);
    if (!old) sections.push({ anchor: s.anchor, heading: s.heading, change: 'added' });
    else {
      sections.push({ anchor: s.anchor, heading: s.heading, change: old.text === s.text ? 'unchanged' : 'modified' });
      byAnchor.delete(s.anchor);
    }
  }
  for (const s of byAnchor.values()) sections.push({ anchor: s.anchor, heading: s.heading, change: 'removed' });
  const lines = diffLines(String(from.body || '').split('\n'), String(to.body || '').split('\n'));
  return { meta, fields, sections, hunks: hunks(lines), stats: { added: lines.filter(l => l.op === '+').length, removed: lines.filter(l => l.op === '-').length } };
}

export async function docDiff(lib, doc, { from, to } = {}) {
  const side = async spec => {
    if (spec === 'draft') {
      if (!doc.draft) throw new RuleError(tr('{id} 沒有草稿或修訂', { id: doc.id }), 404, 'not_found');
      return { label: 'draft', version: null, meta: doc.draft.meta, body: doc.draft.body };
    }
    if (spec === undefined || spec === null || spec === '' || spec === 'current') {
      if (!doc.pub) return { label: 'empty', version: null, meta: {}, body: '' };
      return { label: `v${doc.pub.meta.version}`, version: doc.pub.meta.version, meta: doc.pub.meta, body: doc.pub.body };
    }
    const r = await readVersion(lib, doc, spec);
    return { label: `v${r.version}`, version: r.version, hash: r.hash, meta: r.meta, body: r.body };
  };
  const toSpec = to ?? (doc.draft ? 'draft' : 'current');
  const fromSpec = from ?? (toSpec === 'draft' ? 'current' : Number(toSpec === 'current' ? doc.pub?.meta.version : toSpec) - 1 || 'current');
  const a = await side(fromSpec);
  const b = await side(toSpec);
  return { from: { label: a.label, version: a.version, hash: a.hash || null }, to: { label: b.label, version: b.version, hash: b.hash || null }, ...compareDocs(a, b) };
}
