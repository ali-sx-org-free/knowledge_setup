// 字典完整性檢查：收集介面與服務端用到的原文（字典鍵），對照 zh-CN 與 en 字典，列出缺少、多餘與佔位符不一致的條目。
//   node scripts/i18n-check.js      有問題時以退出碼 1 結束（test/i18n.test.js 也調用這裡的函數）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUBJECT_TYPES, ASSERTION_TYPES, OBJECT_CATEGORIES, OBJECT_STATUS, RELATION_TYPES, ACTION_KINDS, DEFAULT_DOMAINS, LEVEL_INFO, PIPELINE_TYPES, PENDING_REASONS } from '../src/store/model.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET_LOCALES = ['zh-CN', 'en'];

const unquote = s => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
function literalCalls(text, names) {
  const re = new RegExp(`\\b(?:${names.join('|')})\\(\\s*'((?:[^'\\\\\\n]|\\\\.)*)'`, 'g');
  return [...text.matchAll(re)].map(m => unquote(m[1]));
}
function walk(dir, filter) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, filter) : filter(p) ? [p] : [];
  });
}

/** 枚舉值：介面按值翻譯（關係類型、Action 種類用前綴區分同名的值）。 */
export function enumKeys() {
  return [
    ...Object.keys(SUBJECT_TYPES), ...Object.keys(ASSERTION_TYPES), ...Object.keys(OBJECT_CATEGORIES),
    ...Object.values(OBJECT_CATEGORIES).flatMap(c => c.kinds), ...OBJECT_STATUS,
    ...Object.keys(RELATION_TYPES).map(k => `rel|${k}`), ...Object.keys(ACTION_KINDS).map(k => `act|${k}`),
    ...DEFAULT_DOMAINS.map(d => d.name)
  ];
}

export async function webKeys() {
  const keys = new Set(enumKeys());
  const assets = path.join(ROOT, 'web', 'assets');
  for (const f of walk(assets, p => p.endsWith('.js') && !p.includes(`${path.sep}locales${path.sep}`))) for (const k of literalCalls(fs.readFileSync(f, 'utf8'), ['t', 'tk'])) keys.add(k);
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  for (const m of html.matchAll(/<(\w+)\b[^>]*\sdata-i18n(?=[\s>])[^>]*>([^<]*)</g)) keys.add(m[2].trim());
  for (const m of html.matchAll(/<\w+([^>]*)data-i18n-attr="([^"]+)"([^>]*)>/g)) {
    const attrs = m[1] + m[3];
    for (const a of m[2].split(',')) {
      const v = new RegExp(`\\s${a}="([^"]*)"`).exec(attrs);
      if (v) keys.add(v[1]);
    }
  }
  const { DATA_PATTERNS } = await import(pathToFileURL(path.join(assets, 'i18n.js')).href);
  for (const [k] of DATA_PATTERNS) keys.add(k);
  keys.delete('');
  return keys;
}

/** 知識模型的說明文字（Schema、教程按請求語言返回）。 */
export function modelTexts() {
  return [
    ...Object.values(SUBJECT_TYPES).flatMap(v => [v.desc, v.example]), ...Object.values(OBJECT_CATEGORIES).map(v => v.desc),
    ...Object.values(ASSERTION_TYPES), ...Object.values(RELATION_TYPES).flatMap(v => [v.direction, v.example]),
    ...Object.values(ACTION_KINDS), ...Object.values(PIPELINE_TYPES), ...Object.values(PENDING_REASONS),
    ...Object.values(LEVEL_INFO).flatMap(v => [v.name, v.condition, v.usage])
  ];
}

export function serverKeys() {
  const keys = new Set([...enumKeys(), ...modelTexts()]);
  for (const f of walk(path.join(ROOT, 'src'), p => p.endsWith('.js') && !p.includes(`${path.sep}locales${path.sep}`))) for (const k of literalCalls(fs.readFileSync(f, 'utf8'), ['tr', 'tk'])) keys.add(k);
  keys.delete('');
  return keys;
}

const placeholders = s => [...String(typeof s === 'object' ? s.other : s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

export function compare(keys, dict) {
  const missing = [...keys].filter(k => !Object.hasOwn(dict, k));
  const unused = Object.keys(dict).filter(k => !keys.has(k));
  const badPlaceholders = [...keys].filter(k => Object.hasOwn(dict, k) && placeholders(k) !== placeholders(dict[k]));
  const empty = [...keys].filter(k => Object.hasOwn(dict, k) && !dict[k]);
  return { missing, unused, badPlaceholders, empty };
}

export async function loadDict(kind, locale) {
  const file = kind === 'web' ? path.join(ROOT, 'web', 'assets', 'locales', `${locale}.js`) : path.join(ROOT, 'src', 'i18n', 'locales', `${locale}.js`);
  return (await import(pathToFileURL(file).href)).default;
}

export async function report() {
  const out = [];
  for (const [kind, keys] of [['web', await webKeys()], ['server', serverKeys()]]) {
    for (const locale of TARGET_LOCALES) out.push({ kind, locale, ...compare(keys, await loadDict(kind, locale)) });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  let bad = 0;
  for (const r of await report()) {
    for (const [label, list] of [['缺少', r.missing], ['佔位符不一致', r.badPlaceholders], ['譯文為空', r.empty], ['未使用', r.unused]]) {
      if (!list.length) continue;
      if (label !== '未使用') bad += list.length;
      console.log(`[${r.kind} ${r.locale}] ${label} ${list.length} 條`);
      for (const k of list) console.log(`  ${JSON.stringify(k)}`);
    }
  }
  if (!bad) console.log('字典完整');
  process.exit(bad ? 1 : 0);
}
