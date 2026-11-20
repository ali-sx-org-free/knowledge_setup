// 介面多語言：繁體中文是原文（同時是字典的鍵），另有簡體中文與英文字典（./locales/*.js）。
//   t('已新增 {id}', { id })  取目前語言的譯文並替換佔位符；字典裡沒有時回退原文。
//   t('nav|主體')            「小寫前綴|」區分同一原文在不同位置的譯法（如英文單複數）；沒有譯文時顯示「|」後的原文。
//   tv(value, 'rel')         翻譯枚舉值（主體類型、關係類型等）；先找「前綴|值」，再找值本身，都沒有時原樣返回。
//   td(text)                 翻譯服務端寫入知識倉庫的固定措辭（層級歷史原因、重驗說明等），不認識的原樣返回。
// 語言選擇順序：網址 ?lang= → 上次選擇（localStorage）→ 瀏覽器語言 → 英文。

export const LOCALES = [
  { code: 'zh-TW', label: '繁體中文', html: 'zh-Hant' },
  { code: 'zh-CN', label: '简体中文', html: 'zh-Hans' },
  { code: 'en', label: 'English', html: 'en' }
];
export const SOURCE_LOCALE = 'zh-TW';
const FALLBACK_LOCALE = 'en';
const STORAGE_KEY = 'knowledge.lang';

let current = SOURCE_LOCALE;
let dict = null;

/** 把語言標記（zh-HK、zh_CN、en-US…）對應到支持的語言；不支持時返回 null。 */
export function matchLocale(tag) {
  const s = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s || s === '*') return null;
  if (s === 'zh' || s.startsWith('zh-')) return /^zh-(tw|hk|mo|hant)\b/.test(s) ? 'zh-TW' : 'zh-CN';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return null;
}

export function detectLocale({ search = '', stored = null, languages = [] } = {}) {
  const fromQuery = matchLocale(new URLSearchParams(search).get('lang'));
  if (fromQuery) return fromQuery;
  if (LOCALES.some(l => l.code === stored)) return stored;
  for (const l of languages) {
    const m = matchLocale(l);
    if (m) return m;
  }
  return FALLBACK_LOCALE;
}

export const locale = () => current;

/** 標記「稍後再經 t() 翻譯」的原文（例如代碼 → 文字的對照表），讓字典完整性測試能找到它們。 */
export const tk = key => key;

function format(s, params) {
  if (s && typeof s === 'object') s = params?.n === 1 && s.one ? s.one : s.other;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k] ?? '') : m));
}

const CONTEXT = /^[a-z]+\|/;
const lookup = key => (dict && Object.hasOwn(dict, key) ? dict[key] : key.replace(CONTEXT, ''));

export function t(key, params) {
  return format(lookup(key), params);
}

export function tv(value, ctx) {
  if (value === null || value === undefined || value === '') return value;
  const v = String(value);
  if (!dict) return v;
  if (ctx && Object.hasOwn(dict, `${ctx}|${v}`)) return format(dict[`${ctx}|${v}`]);
  return Object.hasOwn(dict, v) ? format(dict[v]) : v;
}

// 服務端寫入知識倉庫的固定措辭（存的是繁體原文）。按順序匹配；捕獲的片段再遞歸翻譯。
export const DATA_PATTERNS = [
  ['降級：{reason}', /^降級：(?<reason>.+)$/s],
  ['失效：{reason}', /^失效：(?<reason>.+)$/s],
  ['Action 校驗通過（{id}）', /^Action 校驗通過（(?<id>[^（）]+)）$/],
  ['客體 {id} 已下線：{reason}', /^客體 (?<id>\S+) 已下線：(?<reason>.*)$/s],
  ['客體 {id} 已下線', /^客體 (?<id>\S+) 已下線$/],
  ['證據客體 {id} 已下線', /^證據客體 (?<id>\S+) 已下線$/],
  ['客體 {id} 定位變更', /^客體 (?<id>\S+) 定位變更$/],
  ['校驗發現客體不存在：{detail}', /^校驗發現客體不存在：(?<detail>.*)$/s],
  ['與 {other} 矛盾（{id}）', /^與 (?<other>\S+) 矛盾（(?<id>[^（）]+)）$/],
  ['裁決 {id}', /^裁決 (?<id>C-\S+)$/],
  ['衝突裁決 {id}：以 {winner} 為準', /^衝突裁決 (?<id>\S+)：以 (?<winner>\S+) 為準$/],
  ['有效期至 {date}', /^有效期至 (?<date>\S+)$/],
  ['負責人 {name} 已確認', /^負責人 (?<name>.+) 已確認$/s],
  ['負責人判定失效：{reason}', /^負責人判定失效：(?<reason>.*)$/s],
  ['實際值 {value} 與斷言一致', /^實際值 (?<value>.+) 與斷言一致$/s],
  ['實際值 {value}，斷言值 {expected}', /^實際值 (?<value>.+)，斷言值 (?<expected>.+)$/s],
  ['客體存在（HTTP {status}）', /^客體存在（HTTP (?<status>\d+)）$/],
  // RPA 校驗寫回的層級歷史備註與最近校驗說明（守衛摘要裡的出參名與值不翻譯）
  ['RPA 運行 {run}（{id}）', /^RPA 運行 (?<run>\S+)（(?<id>[^（）]+)）$/],
  ['守衛全部通過：{summary}', /^守衛全部通過：(?<summary>.*)$/s]
];

// 服務端寫入知識倉庫、會原樣顯示在後台的固定短語（td() 精確匹配）。
export const DATA_PHRASES = [
  tk('data|提交'), tk('缺少 id 欄位'), tk('保鮮觸發器'), tk('補充客體證據'), tk('負責人確認'), tk('重新驗證，延長有效期'), tk('內容修改，需重新驗證'),
  tk('客體下線'), tk('已處理'), tk('已補充知識'), tk('術語未命中任何主體'), tk('命中主體但沒有能回答問題的知識'),
  tk('斷言沒有結構化值，無法比對'), tk('有效期到期'), tk('校驗不符'), tk('知識衝突'), tk('使用反饋指出錯誤'), tk('證據客體已下線'), tk('客體已變化')
];

export function td(text) {
  if (text === null || text === undefined || text === '' || !dict) return text;
  const s = String(text);
  if (Object.hasOwn(dict, `data|${s}`)) return format(dict[`data|${s}`]);
  if (Object.hasOwn(dict, s)) return format(dict[s]);
  for (const [key, re] of DATA_PATTERNS) {
    const m = re.exec(s);
    if (m) return t(key, Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, td(v)])));
  }
  return s;
}

/** 啟動時調用：決定語言、載入字典、翻譯 index.html 中標了 data-i18n 的靜態文字。 */
export async function initI18n() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* 隱私模式等 */ }
  current = detectLocale({ search: location.search, stored, languages: navigator.languages?.length ? navigator.languages : [navigator.language] });
  if (current !== SOURCE_LOCALE) {
    try {
      dict = (await import(`./locales/${current}.js`)).default;
    } catch {
      current = SOURCE_LOCALE;
      dict = null;
    }
  }
  document.documentElement.lang = LOCALES.find(l => l.code === current).html;
  translateDom(document);
  return current;
}

export function translateDom(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18nKey ||= el.textContent.trim());
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const attr of el.dataset.i18nAttr.split(',')) {
      const k = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
      el.dataset[k] ||= el.getAttribute(attr) || '';
      el.setAttribute(attr, t(el.dataset[k]));
    }
  }
}

/** 切換語言：記住選擇後重新載入頁面（頁面結構在載入時按語言生成）。 */
export function setLocale(code) {
  if (!LOCALES.some(l => l.code === code) || code === current) return;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* 忽略 */ }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  if (url.href === location.href) location.reload();
  else location.replace(url.href);
}

/** 語言下拉選單（頂欄與登入頁共用）。 */
export function localeSelect(id) {
  return `<select id="${id}" class="lang-select" aria-label="${current === 'en' ? 'Language' : `${t('語言')} / Language`}">${LOCALES.map(l => `<option value="${l.code}"${l.code === current ? ' selected' : ''}>${l.label}</option>`).join('')}</select>`;
}
