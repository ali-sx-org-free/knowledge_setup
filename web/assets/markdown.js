// 文檔正文的 Markdown：安全渲染、章節切分、引用提取。前後端共用（不依賴 DOM，服務端與測試直接 import）。
//   renderMarkdown(md, { resolveRef, assetUrl })  → { html, toc }
//   parseSections(md)                              → 按 #、##、### 切分的章節（錨點與渲染時的標題 id 一致）
//   extractRefs(md)                                → 正文中的 [[ID]]、[[ID#錨點]]
// 安全規則：正文中的 HTML 一律轉義；鏈接只允許 http、https、mailto 和站內 #；圖片只顯示本文檔的附件（assets/檔名），
// 外部圖片顯示為鏈接，閱讀時不向外部發請求。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export const REF_RE = /\[\[([A-Z]{1,4}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:#([^\]\n]+))?\]\]/g;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const COMMENT = /<!--[\s\S]*?-->/g;
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 去掉行內標記，得到標題的純文字。 */
export function plainText(s) {
  return String(s || '')
    .replace(REF_RE, (m, id, a) => (a ? `${id}#${a}` : id))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^*\w])\*([^*]+)\*(?!\*)/g, '$1$2')
    .trim();
}

/** 章節錨點：標題純文字，空白換成 -，去掉網址中有特殊含義的字元。 */
export function slug(text) {
  return plainText(text).replace(/[#%?/\\"'<>&|^`{}]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
}

/** 逐行標記是否在代碼塊內（代碼塊中的標題、引用、註釋都不算）。 */
function fenceMask(lines) {
  const mask = [];
  let open = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (open) {
      mask.push(true);
      if (m && m[1] === open) open = null;
    } else if (m) {
      open = m[1];
      mask.push(true);
    } else mask.push(false);
  }
  return mask;
}

/** 去掉代碼塊以外的 HTML 註釋（模板提示 <!-- 提示：… --> 預覽時不顯示）。 */
export function stripComments(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    out.push(...buf.join('\n').replace(COMMENT, '').split('\n'));
    buf = [];
  };
  lines.forEach((l, i) => {
    if (mask[i]) { flush(); out.push(l); } else buf.push(l);
  });
  flush();
  return out.join('\n');
}

/**
 * 按標題切分章節。#、##、### 開新章節（#### 及更深留在所屬章節內）；第一個標題之前的內容是錨點為空的前言。
 * 返回 [{ level, heading, anchor, path, line, text, raw }]；line 從 1 起算，對應正文中的標題行。
 */
export function parseSections(md, { maxLevel = 3 } = {}) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const sections = [];
  const used = new Map();
  const stack = [];
  let cur = { level: 0, heading: '', anchor: '', path: [], line: 1, rawLines: [] };
  const push = () => {
    const raw = cur.rawLines.join('\n');
    const text = stripComments(raw).trim();
    if (cur.level || text) sections.push({ level: cur.level, heading: cur.heading, anchor: cur.anchor, path: cur.path, line: cur.line, text, raw });
  };
  lines.forEach((line, i) => {
    const h = !mask[i] && HEADING.exec(line);
    if (h && h[1].length <= maxLevel) {
      push();
      const level = h[1].length;
      const heading = plainText(h[2]);
      let anchor = slug(h[2]);
      const n = (used.get(anchor) || 0) + 1;
      used.set(anchor, n);
      if (n > 1) anchor = `${anchor}-${n}`;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, heading });
      cur = { level, heading, anchor, path: stack.map(s => s.heading), line: i + 1, rawLines: [] };
    } else cur.rawLines.push(line);
  });
  push();
  return sections;
}

/** 正文中的引用（代碼塊和行內代碼中的不算）。 */
export function extractRefs(md) {
  const lines = String(md || '').split('\n');
  const mask = fenceMask(lines);
  const out = [];
  lines.forEach((l, i) => {
    if (mask[i]) return;
    const text = l.replace(/`[^`]*`/g, '');
    for (const m of text.matchAll(REF_RE)) out.push({ id: m[1], anchor: m[2] || null, line: i + 1 });
  });
  return out;
}

export function safeHref(href) {
  const h = String(href || '').trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(h)) return { href: h, external: true };
  if (/^mailto:[^\s<>"']+$/i.test(h)) return { href: h, external: true };
  if (/^#[^\s<>"']*$/.test(h)) return { href: h, external: false };
  return null;
}

const defaultRefHref = (id, anchor) => {
  const p = id.split('-')[0];
  const base = p === 'S' ? `#subject/${id}` : p === 'O' ? `#object/${id}` : p === 'DOC' ? `#doc/${id}` : `#item/${id}`;
  return anchor ? `${base}/${encodeURIComponent(anchor)}` : base;
};

function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
}

const INLINE = /\[\[([A-Z]{1,4}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:#([^\]\n]+))?\]\]|!\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)|\[([^\]\n]+)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/g;

function renderRef(id, anchor, opts) {
  const r = opts.resolveRef?.(id, anchor) || null;
  const href = r?.href || defaultRefHref(id, anchor);
  const state = r?.state || (opts.resolveRef ? 'missing' : 'ok');
  const label = r?.label ? `${r.label}${anchor ? ` § ${anchor}` : ''}` : anchor ? `${id} § ${anchor}` : id;
  const badge = r?.level ? `<span class="ref-level lvl-${escapeHtml(r.level)}">${escapeHtml(r.level)}</span>` : '';
  const title = r?.title || id;
  const idPart = r?.label && r.label !== id ? `<span class="ref-id">${escapeHtml(id)}</span>` : '';
  return `<a class="ref ref-${escapeHtml(state)}" href="${escapeHtml(href)}" data-ref="${escapeHtml(id)}" title="${escapeHtml(title)}">${idPart}${escapeHtml(label)}${badge}</a>`;
}

function inline(text, opts) {
  const parts = String(text).split(/(`+[^`]*?`+)/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`;
    let out = '';
    let last = 0;
    for (const m of part.matchAll(INLINE)) {
      out += emphasis(escapeHtml(part.slice(last, m.index)));
      last = m.index + m[0].length;
      if (m[1]) out += renderRef(m[1], m[2] || null, opts);
      else if (m[3] !== undefined) {
        const src = m[4];
        const asset = /^assets\/(.+)$/.exec(src);
        if (asset && ASSET_NAME.test(asset[1]) && opts.assetUrl) out += `<img src="${escapeHtml(opts.assetUrl(asset[1]))}" alt="${escapeHtml(m[3])}" loading="lazy">`;
        else {
          const safe = safeHref(src);
          const label = `🖼 ${escapeHtml(m[3] || src)}`;
          out += safe ? `<a href="${escapeHtml(safe.href)}" class="ext-image"${safe.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>` : `<span class="ext-image">${label}</span>`;
        }
      } else if (m[5] !== undefined) {
        const safe = safeHref(m[6]);
        const label = emphasis(escapeHtml(m[5]));
        out += safe ? `<a href="${escapeHtml(safe.href)}"${safe.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>` : `<span class="unsafe-link" title="${escapeHtml(m[6])}">${label}</span>`;
      } else {
        const safe = safeHref(m[7]);
        out += safe ? `<a href="${escapeHtml(safe.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m[7])}</a>` : escapeHtml(m[0]);
      }
    }
    return out + emphasis(escapeHtml(part.slice(last)));
  }).join('');
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cellsOf = row => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

function renderList(lines, opts) {
  // lines：連續的列表行（含縮排的續行）；按第一個標記的縮排分項，更深的縮排遞歸成子列表
  const first = LIST_ITEM.exec(lines[0]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    if (m && m[1].length <= indent) items.push({ head: m[3], rest: [] });
    else if (items.length) items[items.length - 1].rest.push(line);
  }
  const lis = items.map(it => {
    let head = it.head;
    let box = '';
    const task = /^\[([ xX])\]\s+(.*)$/.exec(head);
    if (task) { box = task[1] === ' ' ? '<span class="task">☐</span> ' : '<span class="task done">☑</span> '; head = task[2]; }
    const sub = [];
    const text = [];
    let inSub = false;
    for (const r of it.rest) {
      if (LIST_ITEM.test(r) || (inSub && /^\s+\S/.test(r))) { inSub = true; sub.push(r); } else if (r.trim()) text.push(r.trim());
    }
    return `<li>${box}${inline([head, ...text].join(' '), opts)}${sub.length ? renderList(sub, opts) : ''}</li>`;
  });
  return ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis.join('')}</ol>` : `<ul>${lis.join('')}</ul>`;
}

function renderBlocks(lines, opts, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = line.trim().slice(3).trim().split(/\s+/)[0];
      const buf = [];
      i++;
      while (i < lines.length && !(FENCE.exec(lines[i]) && FENCE.exec(lines[i])[1] === fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const tagLevel = Math.min(6, Math.max(2, level));
      let anchor = null;
      if (level <= 3 && ctx.sections) {
        anchor = ctx.sections[ctx.si++]?.anchor || slug(h[2]);
        ctx.toc.push({ level, text: plainText(h[2]), anchor });
      }
      out.push(`<h${tagLevel}${anchor ? ` id="sec-${escapeHtml(anchor)}" data-anchor="${escapeHtml(anchor)}"` : ''}>${inline(h[2], opts)}</h${tagLevel}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(buf, opts, { toc: [], sections: null, si: 0 })}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cellsOf(line);
      const align = cellsOf(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cellsOf(lines[i++]));
      const td = (c, j, tag) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inline(c, opts)}</${tag}>`;
      out.push(`<div class="table-scroll"><table><thead><tr>${head.map((c, j) => td(c, j, 'th')).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, j) => td(r[j] ?? '', j, 'td')).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const buf = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s+\S/.test(lines[i]) && buf.length) || (!lines[i].trim() && i + 1 < lines.length && /^\s+([-*+]|\d+[.)])\s/.test(lines[i + 1])))) {
        if (lines[i].trim()) buf.push(lines[i]);
        i++;
      }
      out.push(renderList(buf, opts));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !/^\s*>/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) para.push(lines[i++]);
    if (!para.length) { out.push(`<p>${inline(lines[i++], opts)}</p>`); continue; }
    out.push(`<p>${para.map(p => inline(p.trim(), opts)).join(para.length > 1 ? '<br>' : '')}</p>`);
  }
  return out.join('\n');
}

/**
 * 渲染文檔正文。
 * @param {string} md
 * @param {object} [opts]
 * @param {(id: string, anchor: string|null) => ({ href?, label?, level?, state?: 'ok'|'e1'|'missing', title? }|null)} [opts.resolveRef]
 * @param {(name: string) => string} [opts.assetUrl]  本文檔附件的地址；不提供時圖片顯示為文字
 */
export function renderMarkdown(md, opts = {}) {
  const source = stripComments(md);
  const sections = parseSections(source).filter(s => s.level);
  const ctx = { toc: [], sections, si: 0 };
  const html = renderBlocks(source.split('\n'), opts, ctx);
  return { html, toc: ctx.toc };
}
