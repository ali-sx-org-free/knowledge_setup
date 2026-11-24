// 證據來源保留原文；列表只展示短標籤，完整來源可查看與複製。
import { esc } from './core.js';
import { t } from './i18n.js';

export function evidenceSourceInfo(sourceRef) {
  const text = String(sourceRef || '').trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { /* 評審說明、記錄編號和舊路徑均按純文字處理。 */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s/.test(text)) {
    return { text, href: null, label: t('來源說明'), hint: '' };
  }
  const ddl = /\/agent-api\/v1\/runs\/tech-dms-sql-show-create-table-[^/]+(?:\/files\/output\.json)?\/?$/.test(url.pathname);
  const date = /-(\d{4})(\d{2})(\d{2})-\d{6}-/.exec(url.pathname);
  return { text, href: url.href, label: ddl ? t('原始 DDL') : t('HTTP 來源'), hint: ddl && date ? `${date[1]}-${date[2]}-${date[3]}` : url.host };
}

export function evidenceSourceHtml(sourceRef) {
  const info = evidenceSourceInfo(sourceRef);
  if (!info) return '';
  const attrs = `data-source-ref="${esc(info.text)}"`;
  const main = info.href
    ? `<a class="evidence-source-link" href="${esc(info.href)}" target="_blank" rel="noopener noreferrer" title="${esc(info.text)}">${esc(info.label)} ↗</a>`
    : `<button type="button" class="text-btn evidence-source-link" data-op="viewEvidenceSource" ${attrs} title="${esc(info.text)}">${esc(info.label)}</button>`;
  return `<span class="evidence-source">${main}<button type="button" class="text-btn evidence-source-tool" data-op="viewEvidenceSource" ${attrs} aria-label="${esc(t('查看完整來源'))}" title="${esc(t('查看完整來源'))}">ⓘ</button><button type="button" class="text-btn evidence-source-tool" data-op="copyEvidenceSource" ${attrs} aria-label="${esc(t('複製來源'))}" title="${esc(t('複製來源'))}">⧉</button></span>`;
}
