// 導出 Markdown 壓縮包（設計 §19 第二期）：已發布的文檔按文件夾放好，圖片放在 _assets/，附 README 索引。
// 包裡的 Markdown 給知識庫以外的工具讀：[[DOC-…]] 改成指向包內檔案的相對鏈接，其他 [[ID]] 改成「名稱（ID）」，
// 圖片 assets/x.png 改成包內的相對路徑；front matter 保留（版本、標籤、關聯等元數據）。代碼塊和行內代碼不改。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createZip } from './zip.js';
import { serializeDoc, fileNameFor } from '../store/docs.js';
import { REF_RE } from '../../web/assets/markdown.js';

const FENCE = /^\s*(```|~~~)/;

/** 只改代碼以外的文字：逐行跳過代碼塊，行內跳過 `…`。 */
function mapOutsideCode(md, fn) {
  let fence = null;
  return String(md || '').split('\n').map(line => {
    const m = FENCE.exec(line);
    if (fence) { if (m && m[1] === fence) fence = null; return line; }
    if (m) { fence = m[1]; return line; }
    return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : fn(part))).join('');
  }).join('\n');
}

const relPath = (fromDir, to) => {
  const r = path.posix.relative(fromDir, to);
  // 只轉義鏈接中有特殊含義的字元，中文原樣保留（Markdown 閱讀器都能打開）
  return r.split('/').map(seg => seg.replace(/[%\s()#?<>[\]]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)).join('/');
};

/**
 * 生成壓縮包。docs：[{ doc }]（已發布版本）。返回 { buffer, files, docs }。
 * 檔案佈局：<文件夾>/<DOC-…-標題>.md、_assets/<DOC-…>/<圖片>、README.md。
 */
export async function markdownZip(lib, docs, { baseUrl = '' } = {}) {
  const st = lib.store;
  const placed = new Map();
  for (const { doc } of docs) placed.set(doc.id, `${lib.folderOf(doc)}/${fileNameFor(doc.id, doc.pub.meta.title)}`);
  const files = [];
  const index = new Map();
  for (const { doc } of docs) {
    const m = doc.pub.meta;
    const file = placed.get(doc.id);
    const dir = path.posix.dirname(file);
    const assets = new Set();
    const body = mapOutsideCode(doc.pub.body, text => text
      .replace(/(!\[[^\]]*\]\()assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})(\))/g, (all, a, name, b) => { assets.add(name); return `${a}${relPath(dir, `_assets/${doc.id}/${name}`)}${b}`; })
      .replace(REF_RE, (all, id, anchor) => {
        if (id.startsWith('DOC-')) {
          const target = placed.get(id);
          const title = lib.docs.get(id) ? lib.head(lib.docs.get(id)).meta.title : id;
          const label = anchor ? `${title}§${anchor}` : title;
          return target ? `[${label}](${relPath(dir, target)}${anchor ? `#${encodeURIComponent(anchor)}` : ''})` : `${label}（${id}）`;
        }
        const r = lib.resolveRef(id);
        return r.label && ['subject', 'object'].includes(r.kind) ? `${r.label}（${id}）` : id;
      }));
    files.push({ name: file, data: serializeDoc(m, body), date: m.change?.publishedAt || m.updatedAt });
    for (const name of assets) {
      const a = lib.assetPath(doc.id, name);
      if (!a) continue;
      try { files.push({ name: `_assets/${doc.id}/${name}`, data: await fs.readFile(a.file) }); } catch { /* 圖片已刪除：鏈接保留 */ }
    }
    const folder = lib.folderOf(doc);
    if (!index.has(folder)) index.set(folder, []);
    index.get(folder).push({ id: doc.id, title: m.title, version: m.version, status: m.status, tags: m.tags || [], file, generated: !!m.generated });
  }
  const at = new Date().toISOString();
  const lines = ['# 文檔庫導出', '', `導出時間：${at}，共 ${docs.length} 篇已發布的文檔。正文中的 [[ID]] 已改為名稱或包內鏈接；原始寫法以知識倉庫為準。${baseUrl ? `在線查看：${baseUrl}/#docs` : ''}`, ''];
  for (const folder of [...index.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${folder}`, '');
    for (const d of index.get(folder).sort((a, b) => a.id.localeCompare(b.id))) lines.push(`- [${d.id} ${d.title}](${relPath('.', d.file)}) · v${d.version ?? '—'} · ${d.status}${d.generated ? ' · 生成' : ''}${d.tags.length ? ` · ${d.tags.map(t => `#${t}`).join(' ')}` : ''}`);
    lines.push('');
  }
  files.unshift({ name: 'README.md', data: `${lines.join('\n').trim()}\n`, date: at });
  return { buffer: createZip(files), files: files.length, docs: docs.length, generatedAt: at, store: st.subdir };
}
