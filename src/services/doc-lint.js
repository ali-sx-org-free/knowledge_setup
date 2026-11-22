// 文檔體檢 D1–D12（設計文件 §9.3）：讓文檔對智能體和檢索系統友好，人也讀得懂。
// 返回 [{ rule, level: error|warning|info, message, section?, line?, field? }]。
// phase：save 保存時（缺項只提醒）、submit 提交審閱、publish 發布（缺項是錯誤）。錯誤阻止提交和發布；D10 機密阻止保存。
import { DYNAMIC_RE } from './ask.js';
import { parseSections, extractRefs, stripComments } from '../../web/assets/markdown.js';
import { checkFields, headingAliases, localizeTemplate, HINT_RE } from '../store/doc-templates.js';
import { tr, tk } from '../i18n/index.js';

export const hasErrors = problems => problems.some(p => p.level === 'error');

const GENERIC_TITLES = new Set(['說明', '说明', '文檔', '文档', '新建文檔', '新建文档', '未命名', '無標題', '无标题', '筆記', '笔记', '草稿', 'untitled', 'document', 'new document', 'readme', 'notes', 'draft', 'doc']);
// 動態值詞表：沿用問答的 DYNAMIC_RE，去掉提問用語（多少、幾個、狀態等），只留「旁邊不該寫具體數字」的詞
const QUESTION_WORDS = new Set(['多少', '幾個', '几个', '幾件', '几件', 'how many', '狀態', '状态', 'status']);
const DYNAMIC_WORDS = new RegExp(DYNAMIC_RE.source.split('|').filter(w => !QUESTION_WORDS.has(w)).join('|'), 'gi');
const RELATIVE_TIME = /最近|近期|日前|目前|上週|上周|本週|本周|下週|下周|上個月|上个月|本月|下個月|下个月|今年|去年|明年|recently|currently|last week|this week|last month|this month|this year|last year|next year/i;
const EXPLICIT_DATE = /\d{4}\s*[-/年.]\s*\d{1,2}|\d{4}\s*年|\b(19|20)\d{2}\b|Q[1-4]\s*\d{4}|\d{4}\s*Q[1-4]/i;

const SECRET_PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['api_key', /\b(?:sk|rk)-(?:or-|ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/],
  ['knowledge_key', /\bkk_[A-Za-z0-9_-]{24,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['bearer', /\b(?:Bearer|Basic)\s+(?!\$\{env:)[A-Za-z0-9._~+/=-]{20,}/],
  ['connection_string', /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]+:(?!\$\{env:)[^\s@/'"`]{3,}@[^\s/'"`]+/i],
  ['password', /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密碼|密码|口令|密鑰|密钥)\s*["']?\s*[:=：]\s*["']?(?!\$\{env:)(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`<>{}]{8,}/i]
];
const SECRET_TEXT = {
  private_key: tk('私鑰'), aws_key: tk('AWS 存取金鑰'), github_token: tk('GitHub 權杖'), slack_token: tk('Slack 權杖'), api_key: tk('API 金鑰'),
  knowledge_key: tk('本系統的 API 金鑰'), jwt: tk('JWT 權杖'), bearer: tk('Authorization 標頭中的權杖'), connection_string: tk('帶密碼的連接字串'), password: tk('密碼或金鑰賦值')
};

/** 逐行查找疑似機密；返回 [{ kind, line }]（不返回機密本身）。 */
export function findSecrets(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) { out.push({ kind, line: i + 1 }); break; }
  });
  return out;
}

const sectionAt = (sections, line) => {
  let hit = null;
  for (const s of sections) if (s.level && s.line <= line) hit = s;
  return hit?.heading || null;
};

/**
 * @param {import('../store/docs.js').DocLibrary} lib
 * @param {{ id?: string, meta: object, body: string, folder?: string }} doc
 * @param {{ phase?: 'save'|'submit'|'publish', fieldProblems?: object[] }} [opts]
 */
export function lintDoc(lib, { id, meta, body, folder }, { phase = 'save', fieldProblems } = {}) {
  const st = lib.store;
  const problems = [];
  const add = (rule, level, message, extra = {}) => problems.push({ rule, level, message, ...extra });
  const strict = phase !== 'save';
  const tpl = lib.templates.get(meta.template);
  const text = String(body || '');
  const lines = text.split('\n');
  const sections = parseSections(text);

  // D10 機密：正文、摘要、欄位
  for (const s of findSecrets(text)) add('D10', 'error', tr('第 {line} 行疑似包含{kind}', { line: s.line, kind: tr(SECRET_TEXT[s.kind]) }), { line: s.line, section: sectionAt(sections, s.line) });
  const metaText = [meta.title, meta.summary, ...Object.values(meta.fields || {}).flat()].filter(Boolean).join('\n');
  if (findSecrets(metaText).length) add('D10', 'error', tr('標題、摘要或欄位中疑似包含機密'));

  // D1 標題
  const title = String(meta.title || '').trim();
  if (!title) add('D1', 'error', tr('缺少標題'));
  else if (GENERIC_TITLES.has(title.toLowerCase())) add('D1', 'warning', tr('標題「{title}」過於籠統：寫明講的是什麼，例如「可售庫存口徑定義」', { title }));
  if (title && folder) {
    for (const d of lib.docs.values()) {
      if (d.id === id || lib.folderOf(d).toLowerCase() !== String(folder).toLowerCase()) continue;
      if ([d.pub?.meta.title, d.draft?.meta.title].some(x => x && x.toLowerCase() === title.toLowerCase())) add('D1', 'error', tr('文件夾「{folder}」已有同名文檔 {id}', { folder, id: d.id }));
    }
  }

  // D2 摘要
  const summary = String(meta.summary || '').trim();
  if (!summary) add('D2', strict ? 'error' : 'warning', tr('發布前需要摘要：一兩句話說明這篇文檔講什麼；搜索結果、知識卡和智能體首先讀它'));
  else if ([...summary].length > 200) add('D2', 'error', tr('摘要不超過 200 字（目前 {n} 字）', { n: [...summary].length }));

  // D3 章節
  sections.filter(s => s.level === 1).forEach(s => add('D3', 'warning', tr('正文不用一級標題「# {heading}」（標題已是一級），請改為 ##', { heading: s.heading }), { line: s.line, section: s.heading }));
  if (text.trim() && !sections.some(s => s.level)) add('D3', 'warning', tr('正文沒有分章節：用 ## 和 ### 分章節，檢索按章節切分'));
  for (const s of sections) if ([...s.text].length > 2000) add('D3', 'warning', tr('章節「{heading}」超過 2,000 字，建議拆分', { heading: s.heading || tr('前言') }), { line: s.line, section: s.heading });
  if ([...text].length > 50000) add('D3', 'warning', tr('正文超過 50,000 字，建議拆成多篇文檔'));

  // D4 模板欄位與章節
  if (!tpl) add('D4', 'error', tr('模板 {id} 不存在', { id: meta.template }));
  else {
    const fp = fieldProblems || checkFields(tpl, meta.fields, { store: st, docs: lib.docs, phase }).problems;
    problems.push(...fp);
    const view = localizeTemplate(tpl);
    const present = new Map(sections.filter(s => s.level).map(s => [s.heading.toLowerCase(), s]));
    tpl.sections.forEach((sec, i) => {
      const aliases = headingAliases(tpl, sec);
      const hit = aliases.map(a => present.get(a)).find(Boolean);
      const label = view.sections[i].headingText;
      if (!hit) {
        if (sec.required) add('D4', strict ? 'error' : 'warning', tr('缺少必填章節「{heading}」', { heading: label }), { section: label });
        return;
      }
      const hint = HINT_RE.test(hit.raw);
      // D5 提示沒有替換，且章節沒有內容
      if (!hit.text) {
        if (hint) add('D5', sec.required ? (strict ? 'error' : 'info') : (strict ? 'warning' : 'info'), sec.required ? tr('章節「{heading}」還是模板提示，沒有內容', { heading: hit.heading }) : tr('可選章節「{heading}」沒有內容：填寫或刪除', { heading: hit.heading }), { line: hit.line, section: hit.heading });
        else if (sec.required) add('D4', strict ? 'error' : 'warning', tr('必填章節「{heading}」沒有內容', { heading: hit.heading }), { line: hit.line, section: hit.heading });
      }
    });
    // D12 管理文檔的負責人
    if (tpl.purpose === '管理' && !String(meta.owner || '').trim() && !(meta.ownerIds || []).length) add('D12', strict ? 'error' : 'warning', tr('管理文檔需要負責人（owner）'));
  }

  // D6 引用
  const refs = extractRefs(text);
  const seen = new Set();
  for (const r of refs) {
    const key = `${r.id}#${r.anchor || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.id === id) continue;
    const info = lib.resolveRef(r.id);
    const section = sectionAt(sections, r.line);
    if (info.state === 'missing') add('D6', 'error', tr('引用的 {id} 不存在', { id: r.id }), { line: r.line, section });
    else if (info.state === 'e1') add('D6', 'warning', info.replacedBy ? tr('引用了已失效的 {id}，替代者是 {replacedBy}', { id: r.id, replacedBy: info.replacedBy }) : tr('引用了已失效的 {id}', { id: r.id }), { line: r.line, section });
    else if (r.anchor && info.kind === 'doc' && !info.anchors.includes(r.anchor)) add('D6', 'warning', tr('{id} 沒有章節「{anchor}」', { id: r.id, anchor: r.anchor }), { line: r.line, section });
  }
  const linkRe = /\]\(#(subject|object|doc|item)\/([A-Za-z0-9-]+)/g;
  lines.forEach((l, i) => {
    for (const m of l.matchAll(linkRe)) {
      const info = lib.resolveRef(m[2]);
      if (info.state === 'missing') add('D6', 'error', tr('鏈接指向的 {id} 不存在', { id: m[2] }), { line: i + 1, section: sectionAt(sections, i + 1) });
    }
  });

  // D7 術語：提到已登記的主體但沒有關聯；用了多義別名
  const plain = stripComments(text).split('\n').filter(l => !/^\s*(```|~~~)/.test(l)).join('\n').slice(0, 50000);
  const resolved = st.resolveTerms(plain);
  const linked = new Set([...(meta.subjects || []), ...Object.values(meta.fields || {}).flat()]);
  const firstLine = start => plain.slice(0, start).split('\n').length;
  let suggestions = 0;
  for (const sid of resolved.canonical) {
    if (linked.has(sid)) continue;
    if (suggestions++ >= 10) break;
    const s = st.subjects.get(sid);
    const m = resolved.matches.find(x => x.id === sid || (st.subjects.get(x.id)?.type === '別名' && st.aliasTargets(st.subjects.get(x.id)).includes(sid)));
    const line = m ? firstLine(m.start) : undefined;
    add('D7', 'info', tr('正文提到「{name}」（{id}），尚未關聯', { name: s?.name || sid, id: sid }), { line, section: line ? sectionAt(sections, line) : null, subjectId: sid });
  }
  for (const a of resolved.ambiguous) add('D7', 'warning', tr('「{term}」是多義別名，建議寫規範名：{list}', { term: a.term, list: a.candidates.map(c => `${c.name}（${c.id}）`).join(tr('、')) }));

  // D8 動態值、D9 相對時間（代碼塊外）
  let inFence = false;
  let d8 = 0;
  let d9 = 0;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const line = l.replace(/`[^`]*`/g, '').replace(/<!--.*?-->/g, '').replace(/\[\[[^\]]*\]\]/g, '').replace(/\b[A-Z]{1,4}-[A-Z0-9-]*\d+\b/g, '').replace(/\]\([^)]*\)/g, ']');
    for (const m of line.matchAll(DYNAMIC_WORDS)) {
      const near = line.slice(Math.max(0, m.index - 6), m.index) + line.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (/\d/.test(near.replace(/\d{4}-\d{2}-\d{2}|v\d+|V\d+/g, '')) && d8++ < 5) {
        add('D8', 'warning', tr('第 {line} 行在「{word}」旁寫了具體數字：動態值不寫數字，寫明以哪個系統為準、怎麼取', { line: i + 1, word: m[0] }), { line: i + 1, section: sectionAt(sections, i + 1) });
        break;
      }
    }
    const rt = RELATIVE_TIME.exec(line);
    if (rt && !EXPLICIT_DATE.test(line) && d9++ < 5) add('D9', 'info', tr('第 {line} 行的「{word}」沒有寫明日期：寫成具體日期，日後才讀得懂', { line: i + 1, word: rt[0] }), { line: i + 1, section: sectionAt(sections, i + 1) });
  });

  // D11 關聯
  if (!(meta.subjects || []).length && !(meta.objects || []).length) add('D11', 'warning', tr('沒有關聯任何主體或客體：關聯後，主體頁和知識卡才找得到這篇文檔'));

  return problems;
}

