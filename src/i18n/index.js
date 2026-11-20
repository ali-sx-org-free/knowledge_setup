// 服務端多語言：與管理後台相同，繁體中文原文即字典鍵，另有簡體中文與英文字典（./locales/*.js）。
//   tr(原文, { id })   按目前請求的語言取譯文並替換 {id} 這類佔位符；字典裡沒有時回退原文。
//   tk(原文)           只標記「稍後再經 tr() 翻譯」的原文，讓字典完整性檢查（scripts/i18n-check.js）找到它。
//   tr(原文, 參數, 語言) 指定語言；寫入知識倉庫的內容用 SOURCE_LOCALE（繁體原文）。
// 原文必須以單引號字面量直接寫在 tr( / tk( 之後，檢查腳本才收集得到。
// 請求的語言：?lang= → Accept-Language → 預設語言（環境變數 KNOWLEDGE_LANG，未設定時為繁體中文）。
// 語言經 AsyncLocalStorage 傳給同一請求內的所有調用（包括知識庫的寫入事務）；排程任務與日誌使用預設語言。
// 只翻譯返回給調用方的文字（錯誤、提示、說明、教程）。寫入知識倉庫的內容（層級歷史、提交說明、預設的處理結果等）
// 一律保持繁體原文，避免倉庫內容隨提交者的語言變化；管理後台顯示時再翻譯。枚舉值（主體類型、關係類型等）是 API 的值，不翻譯。
import { AsyncLocalStorage } from 'node:async_hooks';
import zhCN from './locales/zh-CN.js';
import en from './locales/en.js';

export const LOCALES = ['zh-TW', 'zh-CN', 'en'];
export const SOURCE_LOCALE = 'zh-TW';
const DICTS = { 'zh-CN': zhCN, en };
const storage = new AsyncLocalStorage();
let defaultLocale = SOURCE_LOCALE;

/** 把語言標記（zh-HK、zh_CN、en-US…）對應到支持的語言；不支持時返回 null。 */
export function matchLocale(tag) {
  const s = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s || s === '*') return null;
  if (s === 'zh' || s.startsWith('zh-')) return /^zh-(tw|hk|mo|hant)\b/.test(s) ? 'zh-TW' : 'zh-CN';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return null;
}

/** 解析 Accept-Language（按 q 值排序），返回第一個支持的語言；都不支持時返回 null。 */
export function negotiate(header) {
  const ranked = String(header || '').split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map(p => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
    return { tag, q: q ? Number(q[1]) : 1, i };
  }).filter(x => x.tag && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const m = matchLocale(tag);
    if (m) return m;
  }
  return null;
}

export function setDefaultLocale(tag) {
  defaultLocale = matchLocale(tag) || SOURCE_LOCALE;
  return defaultLocale;
}
export const getDefaultLocale = () => defaultLocale;
export const currentLocale = () => storage.getStore()?.locale || defaultLocale;
export const runWithLocale = (locale, fn) => storage.run({ locale: matchLocale(locale) || defaultLocale }, fn);

export function localeOf(req) {
  return matchLocale(req.query?.lang) || negotiate(req.headers['accept-language']) || defaultLocale;
}

/** Express 中介層：決定請求語言，寫入 req.locale 與 Content-Language，並讓後續處理都在該語言下執行。 */
export function localeMiddleware() {
  return (req, res, next) => {
    req.locale = localeOf(req);
    res.setHeader('Content-Language', req.locale);
    res.vary?.('Accept-Language');
    storage.run({ locale: req.locale }, next);
  };
}

const CONTEXT = /^[a-z]+\|/;

function format(s, params) {
  if (s && typeof s === 'object') s = params?.n === 1 && s.one ? s.one : s.other;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k] ?? '') : m));
}

export function tr(key, params, locale = currentLocale()) {
  const dict = DICTS[locale];
  return format(dict && Object.hasOwn(dict, key) ? dict[key] : key.replace(CONTEXT, ''), params);
}

export const tk = key => key;
