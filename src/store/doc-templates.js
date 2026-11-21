// 文檔模板：內置 6 個模板、模板校驗、正文骨架生成、模板欄位校驗。
// 模板存在知識倉庫的 doc-templates/TPL-*.yaml，名稱、欄位名、章節名是繁體原文；
// 內置模板另帶 i18n（簡體、英文），用於按請求語言生成骨架和顯示，體檢比對章節時三種寫法都算數。
import { RuleError } from './validity.js';
import { SUBJECT_TYPES, OBJECT_CATEGORIES, ASSERTION_TYPES, DOC_PURPOSE, DOC_FIELD_TYPES } from './model.js';
import { tr, currentLocale, SOURCE_LOCALE } from '../i18n/index.js';

const F = (key, label, type, extra = {}) => ({ key, label, type, ...extra });
const S = (heading, extra = {}) => ({ heading, ...extra });

export const BUILTIN_TEMPLATES = [
  {
    id: 'TPL-0001', name: '知識條目', purpose: '知識', objectKind: '知識文檔', approval: 'contributor', reviewEveryDays: null, immutable: false, defaultFolder: '通用',
    description: '解釋一個概念、一條規則或一個常見問題，給人和智能體讀',
    fields: [F('topic', '主題主體', 'subjects', { link: true })],
    sections: [
      S('概述', { required: true, guidance: '兩三句話說清是什麼、什麼時候用' }),
      S('詳細說明', { required: true, guidance: '展開說明；講到已登記的主體時用 [[S-…]] 引用' }),
      S('示例'),
      S('常見問題', { guidance: '一問一答，問題寫成讀者會問的原話' }),
      S('相關知識', { guidance: '用 [[ID]] 列出相關的主體、斷言或文檔' })
    ],
    i18n: {
      'zh-CN': { name: '知识条目', description: '解释一个概念、一条规则或一个常见问题，给人和智能体读', fields: { topic: '主题主体' }, sections: { 概述: ['概述', '两三句话说清是什么、什么时候用'], 詳細說明: ['详细说明', '展开说明；讲到已登记的主体时用 [[S-…]] 引用'], 示例: ['示例'], 常見問題: ['常见问题', '一问一答，问题写成读者会问的原话'], 相關知識: ['相关知识', '用 [[ID]] 列出相关的主体、断言或文档'] } },
      en: { name: 'Knowledge article', description: 'Explains a concept, a rule or a frequently asked question, for people and agents', fields: { topic: 'Topic subjects' }, sections: { 概述: ['Overview', 'Two or three sentences: what it is and when it applies'], 詳細說明: ['Details', 'Explain in full; reference registered subjects with [[S-…]]'], 示例: ['Examples'], 常見問題: ['FAQ', 'One question and answer each, phrased the way readers ask'], 相關知識: ['Related knowledge', 'List related subjects, assertions or documents with [[ID]]'] } }
    }
  },
  {
    id: 'TPL-0002', name: '設計文檔', purpose: '知識', objectKind: '設計文檔', approval: 'owner', reviewEveryDays: 365, immutable: false, defaultFolder: '通用',
    description: '系統或功能的設計：背景、目標、方案、接口與風險',
    fields: [F('systems', '涉及系統', 'subjects', { subjectTypes: ['系統'], link: true }), F('state', '狀態', 'enum', { options: ['提議', '已採納', '已實施'] })],
    sections: [
      S('背景', { required: true, guidance: '為什麼要做：現狀與問題' }),
      S('目標與非目標', { required: true, guidance: '分條列出要達成的目標，以及明確不做的事' }),
      S('方案', { required: true, guidance: '方案本身；涉及的系統、業務對象用 [[S-…]] 引用' }),
      S('數據與接口', { guidance: '涉及的表、字段、接口，用 [[O-…]] 引用已登記的客體' }),
      S('風險與待決問題'),
      S('決定記錄', { guidance: '日期、決定、理由' })
    ],
    i18n: {
      'zh-CN': { name: '设计文档', description: '系统或功能的设计：背景、目标、方案、接口与风险', fields: { systems: '涉及系统', state: '状态' }, options: { 提議: '提议', 已採納: '已采纳', 已實施: '已实施' }, sections: { 背景: ['背景', '为什么要做：现状与问题'], 目標與非目標: ['目标与非目标', '分条列出要达成的目标，以及明确不做的事'], 方案: ['方案', '方案本身；涉及的系统、业务对象用 [[S-…]] 引用'], 數據與接口: ['数据与接口', '涉及的表、字段、接口，用 [[O-…]] 引用已登记的客体'], 風險與待決問題: ['风险与待决问题'], 決定記錄: ['决定记录', '日期、决定、理由'] } },
      en: { name: 'Design document', description: 'Design of a system or feature: background, goals, approach, interfaces and risks', fields: { systems: 'Systems involved', state: 'State' }, options: { 提議: 'Proposed', 已採納: 'Adopted', 已實施: 'Implemented' }, sections: { 背景: ['Background', 'Why: the current situation and the problem'], 目標與非目標: ['Goals and non-goals', 'List the goals, and what is explicitly out of scope'], 方案: ['Approach', 'The design itself; reference systems and business objects with [[S-…]]'], 數據與接口: ['Data and interfaces', 'Tables, fields and APIs involved; reference registered objects with [[O-…]]'], 風險與待決問題: ['Risks and open questions'], 決定記錄: ['Decision log', 'Date, decision, reason'] } }
    }
  },
  {
    id: 'TPL-0003', name: 'SOP', purpose: '管理', objectKind: 'SOP', approval: 'owner', reviewEveryDays: 180, immutable: false, defaultFolder: '通用',
    description: '標準作業程序：誰在什麼條件下按什麼步驟做，出了異常怎麼辦',
    fields: [F('process', '流程', 'subject', { subjectTypes: ['流程'], required: true, link: true }), F('roles', '執行角色', 'text', { required: true }), F('effectiveFrom', '生效日期', 'date', { required: true })],
    sections: [
      S('目的', { required: true, guidance: '這份 SOP 要保證什麼' }),
      S('適用範圍', { required: true, guidance: '適用的倉庫、業務、渠道；不適用的情況' }),
      S('角色與職責', { required: true, guidance: '每個角色負責哪些步驟' }),
      S('前置條件'),
      S('操作步驟', { required: true, guidance: '編號列出，一步一個動作；涉及系統操作時寫明系統和頁面' }),
      S('異常處理', { required: true, guidance: '常見異常、處理方式和升級對象' }),
      S('記錄與表單')
    ],
    i18n: {
      'zh-CN': { name: 'SOP', description: '标准作业程序：谁在什么条件下按什么步骤做，出了异常怎么办', fields: { process: '流程', roles: '执行角色', effectiveFrom: '生效日期' }, sections: { 目的: ['目的', '这份 SOP 要保证什么'], 適用範圍: ['适用范围', '适用的仓库、业务、渠道；不适用的情况'], 角色與職責: ['角色与职责', '每个角色负责哪些步骤'], 前置條件: ['前置条件'], 操作步驟: ['操作步骤', '编号列出，一步一个动作；涉及系统操作时写明系统和页面'], 異常處理: ['异常处理', '常见异常、处理方式和升级对象'], 記錄與表單: ['记录与表单'] } },
      en: { name: 'SOP', description: 'Standard operating procedure: who does what, under which conditions, in which steps, and what to do when things go wrong', fields: { process: 'Process', roles: 'Roles', effectiveFrom: 'Effective from' }, sections: { 目的: ['Purpose', 'What this SOP guarantees'], 適用範圍: ['Scope', 'Warehouses, businesses and channels it applies to; where it does not apply'], 角色與職責: ['Roles and responsibilities', 'Which steps each role owns'], 前置條件: ['Preconditions'], 操作步驟: ['Procedure', 'Numbered, one action per step; name the system and page for system operations'], 異常處理: ['Exception handling', 'Common exceptions, how to handle them and whom to escalate to'], 記錄與表單: ['Records and forms'] } }
    }
  },
  {
    id: 'TPL-0004', name: '口徑定義', purpose: '管理', objectKind: '口徑定義', approval: 'owner', reviewEveryDays: 180, immutable: false, defaultFolder: '通用',
    description: '指標的統一計算口徑。發布後作為指標類主體的證據',
    fields: [
      F('metric', '指標', 'subject', { subjectTypes: ['指標'], required: true, link: true }),
      F('ownerSystem', '權威系統', 'subject', { subjectTypes: ['系統'], link: true }),
      F('effectiveFrom', '生效日期', 'date', { required: true }),
      F('scope', '適用範圍', 'enum', { options: ['全渠道', '線上', '線下'] })
    ],
    sections: [
      S('定義', { required: true, guidance: '一句話說明它是什麼、不是什麼', knowledge: '定義' }),
      S('計算公式', { required: true, guidance: '用已登記的指標名寫公式，涉及的指標用 [[S-…]] 引用', knowledge: '定義' }),
      S('數據來源', { required: true, guidance: '權威表、字段或接口，用 [[O-…]] 引用已登記的客體' }),
      S('邊界情況', { guidance: '負數、缺失、跨倉等特殊情況怎麼處理', knowledge: '約束' }),
      S('示例'),
      S('變更說明', { guidance: '與上一版相比改了什麼、從何時生效' })
    ],
    i18n: {
      'zh-CN': { name: '口径定义', description: '指标的统一计算口径。发布后作为指标类主体的证据', fields: { metric: '指标', ownerSystem: '权威系统', effectiveFrom: '生效日期', scope: '适用范围' }, options: { 全渠道: '全渠道', 線上: '线上', 線下: '线下' }, sections: { 定義: ['定义', '一句话说明它是什么、不是什么'], 計算公式: ['计算公式', '用已登记的指标名写公式，涉及的指标用 [[S-…]] 引用'], 數據來源: ['数据来源', '权威表、字段或接口，用 [[O-…]] 引用已登记的客体'], 邊界情況: ['边界情况', '负数、缺失、跨仓等特殊情况怎么处理'], 示例: ['示例'], 變更說明: ['变更说明', '与上一版相比改了什么、从何时生效'] } },
      en: { name: 'Metric definition', description: 'The single agreed calculation of a metric. Once published it is evidence for metric subjects', fields: { metric: 'Metric', ownerSystem: 'System of record', effectiveFrom: 'Effective from', scope: 'Scope' }, options: { 全渠道: 'All channels', 線上: 'Online', 線下: 'Offline' }, sections: { 定義: ['Definition', 'One sentence: what it is and what it is not'], 計算公式: ['Formula', 'Write the formula with registered metric names; reference metrics with [[S-…]]'], 數據來源: ['Data sources', 'Authoritative tables, fields or APIs; reference registered objects with [[O-…]]'], 邊界情況: ['Edge cases', 'How negatives, missing data, cross-warehouse cases and the like are handled'], 示例: ['Examples'], 變更說明: ['Change notes', 'What changed since the previous version and when it takes effect'] } }
    }
  },
  {
    id: 'TPL-0005', name: 'SLA', purpose: '管理', objectKind: 'SLA', approval: 'owner', reviewEveryDays: 90, immutable: false, defaultFolder: '通用',
    description: '服務水平協議：服務方對使用方承諾的指標、目標值、計量方式與升級機制',
    fields: [
      F('provider', '服務方', 'subject', { subjectTypes: ['系統'], required: true, link: true }),
      F('consumer', '使用方', 'subjects', { subjectTypes: ['系統', '流程'], required: true, link: true }),
      F('effectiveFrom', '生效日期', 'date', { required: true }),
      F('expiresOn', '到期日期', 'date')
    ],
    sections: [
      S('服務範圍', { required: true, guidance: '承諾覆蓋的接口、時段和業務' }),
      S('指標與目標值', { required: true, guidance: '表格列出指標、目標值、統計週期' }),
      S('計量方式', { required: true, guidance: '數據從哪裡來、怎麼算，用 [[O-…]] 引用監控指標' }),
      S('例外情況'),
      S('升級與通報', { required: true, guidance: '未達標時通知誰、多久內響應' })
    ],
    i18n: {
      'zh-CN': { name: 'SLA', description: '服务水平协议：服务方对使用方承诺的指标、目标值、计量方式与升级机制', fields: { provider: '服务方', consumer: '使用方', effectiveFrom: '生效日期', expiresOn: '到期日期' }, sections: { 服務範圍: ['服务范围', '承诺覆盖的接口、时段和业务'], 指標與目標值: ['指标与目标值', '表格列出指标、目标值、统计周期'], 計量方式: ['计量方式', '数据从哪里来、怎么算，用 [[O-…]] 引用监控指标'], 例外情況: ['例外情况'], 升級與通報: ['升级与通报', '未达标时通知谁、多久内响应'] } },
      en: { name: 'SLA', description: 'Service level agreement: the metrics, targets, measurement and escalation a provider commits to', fields: { provider: 'Provider', consumer: 'Consumers', effectiveFrom: 'Effective from', expiresOn: 'Expires on' }, sections: { 服務範圍: ['Service scope', 'APIs, hours and business covered'], 指標與目標值: ['Metrics and targets', 'A table of metric, target and period'], 計量方式: ['Measurement', 'Where the data comes from and how it is calculated; reference monitoring metrics with [[O-…]]'], 例外情況: ['Exclusions'], 升級與通報: ['Escalation and notification', 'Whom to notify when a target is missed, and how fast to respond'] } }
    }
  },
  {
    id: 'TPL-0006', name: '評審記錄', purpose: '管理', objectKind: '評審記錄', approval: 'contributor', reviewEveryDays: null, immutable: true, defaultFolder: '通用',
    description: '一次評審的記錄：評審對象、參與人、結論與待辦。發布後不再修改，有誤時廢止並發一份新記錄',
    fields: [
      F('target', '評審對象', 'doc', { required: true, link: true }),
      F('reviewedOn', '評審日期', 'date', { required: true }),
      F('participants', '參與人', 'text', { required: true }),
      F('verdict', '結論', 'enum', { required: true, options: ['通過', '有條件通過', '不通過'] })
    ],
    sections: [
      S('評審內容', { required: true, guidance: '評審了什麼：文檔版本、方案要點' }),
      S('意見與討論'),
      S('結論', { required: true, guidance: '結論和理由；有條件通過時寫明條件' }),
      S('待辦事項', { guidance: '事項、負責人、期限' })
    ],
    i18n: {
      'zh-CN': { name: '评审记录', description: '一次评审的记录：评审对象、参与人、结论与待办。发布后不再修改，有误时废止并发一份新记录', fields: { target: '评审对象', reviewedOn: '评审日期', participants: '参与人', verdict: '结论' }, options: { 通過: '通过', 有條件通過: '有条件通过', 不通過: '不通过' }, sections: { 評審內容: ['评审内容', '评审了什么：文档版本、方案要点'], 意見與討論: ['意见与讨论'], 結論: ['结论', '结论和理由；有条件通过时写明条件'], 待辦事項: ['待办事项', '事项、负责人、期限'] } },
      en: { name: 'Review record', description: 'The record of one review: what was reviewed, who took part, the verdict and follow-ups. Not edited after publishing; if wrong, make it obsolete and publish a new record', fields: { target: 'Reviewed document', reviewedOn: 'Review date', participants: 'Participants', verdict: 'Verdict' }, options: { 通過: 'Approved', 有條件通過: 'Approved with conditions', 不通過: 'Rejected' }, sections: { 評審內容: ['Scope of review', 'What was reviewed: document version, key points of the proposal'], 意見與討論: ['Comments and discussion'], 結論: ['Verdict', 'The verdict and why; list the conditions when approved with conditions'], 待辦事項: ['Follow-ups', 'Item, owner, due date'] } }
    }
  }
];

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const bad = (message, code = 'invalid_template') => new RuleError(message, 400, code);
const clean = v => (typeof v === 'string' ? v.trim() : v);

/** 校驗並規範化模板（新增、修改時）。返回可寫入倉庫的模板。 */
export function normalizeTemplate(input, { id, objectKinds } = {}) {
  const name = clean(input.name);
  if (!name) throw bad(tr('模板名稱必填'));
  const purpose = input.purpose || '知識';
  if (!DOC_PURPOSE[purpose]) throw bad(tr('模板類別必須為：{list}', { list: Object.keys(DOC_PURPOSE).join(tr('、')) }));
  const approval = input.approval || (purpose === '管理' ? 'owner' : 'contributor');
  if (!['owner', 'contributor'].includes(approval)) throw bad(tr('{field} 必須為 {values}', { field: 'approval', values: 'owner / contributor' }));
  const objectKind = clean(input.objectKind) || '知識文檔';
  if (objectKinds && !objectKinds.includes(objectKind)) throw bad(tr('客體種類 {kind} 不是制度類客體的種類；可用：{list}', { kind: objectKind, list: objectKinds.join(tr('、')) }));
  const days = input.reviewEveryDays === null || input.reviewEveryDays === undefined || input.reviewEveryDays === '' ? null : Number(input.reviewEveryDays);
  if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) throw bad(tr('複審週期必須是 1–3650 的整數天'));
  const fields = (Array.isArray(input.fields) ? input.fields : []).map((f, i) => {
    const key = clean(f?.key);
    if (!KEY_RE.test(key || '')) throw bad(tr('第 {n} 個欄位的鍵 {key} 不合法：以字母開頭，只含字母、數字、底線，最長 40 字元', { n: i + 1, key: key || '' }));
    if (!DOC_FIELD_TYPES.includes(f.type)) throw bad(tr('欄位 {key} 的類型必須為：{list}', { key, list: DOC_FIELD_TYPES.join(', ') }));
    const out = { key, label: clean(f.label) || key, type: f.type };
    if (f.required) out.required = true;
    if (['enum', 'enums'].includes(f.type)) {
      out.options = (Array.isArray(f.options) ? f.options : []).map(o => String(o).trim()).filter(Boolean);
      if (!out.options.length) throw bad(tr('欄位 {key} 是選項類型，需要 options', { key }));
    }
    if (['subject', 'subjects'].includes(f.type) && Array.isArray(f.subjectTypes) && f.subjectTypes.length) {
      for (const st of f.subjectTypes) if (!SUBJECT_TYPES[st]) throw bad(tr('欄位 {key} 的主體類型 {type} 不存在', { key, type: st }));
      out.subjectTypes = f.subjectTypes;
    }
    if (['object', 'objects'].includes(f.type) && Array.isArray(f.objectCategories) && f.objectCategories.length) {
      for (const c of f.objectCategories) if (!OBJECT_CATEGORIES[c]) throw bad(tr('欄位 {key} 的客體類別 {category} 不存在', { key, category: c }));
      out.objectCategories = f.objectCategories;
    }
    if (f.link && ['subject', 'subjects', 'object', 'objects', 'doc'].includes(f.type)) out.link = true;
    return out;
  });
  const keys = new Set();
  for (const f of fields) {
    if (keys.has(f.key)) throw bad(tr('欄位鍵 {key} 重複', { key: f.key }));
    keys.add(f.key);
  }
  const sections = (Array.isArray(input.sections) ? input.sections : []).map((s, i) => {
    const heading = clean(s?.heading);
    if (!heading || heading.length > 40 || /[#\n]/.test(heading)) throw bad(tr('第 {n} 個章節的標題必填，不含 # 和換行，最長 40 字', { n: i + 1 }));
    const out = { heading };
    if (s.required) out.required = true;
    if (clean(s.guidance)) out.guidance = clean(s.guidance).replace(/-->/g, '→');
    if (s.knowledge) {
      if (!ASSERTION_TYPES[s.knowledge]) throw bad(tr('章節 {heading} 的 knowledge 必須是斷言類型之一', { heading }));
      out.knowledge = s.knowledge;
    }
    return out;
  });
  const headings = new Set();
  for (const s of sections) {
    if (headings.has(s.heading)) throw bad(tr('章節標題 {heading} 重複', { heading: s.heading }));
    headings.add(s.heading);
  }
  const tpl = {
    id, name, purpose, description: clean(input.description) || null, objectKind, approval, reviewEveryDays: days,
    immutable: input.immutable === true, defaultFolder: clean(input.defaultFolder) || null, fields, sections
  };
  if (input.i18n && typeof input.i18n === 'object') tpl.i18n = input.i18n;
  return tpl;
}

/** 模板在某語言下的顯示：名稱、說明、欄位名、章節名與提示。值（鍵、選項值）不變。 */
export function localizeTemplate(tpl, locale = currentLocale()) {
  if (!tpl) return tpl;
  const l = locale === SOURCE_LOCALE ? null : tpl.i18n?.[locale];
  return {
    ...tpl,
    i18n: undefined,
    label: l?.name || tpl.name,
    descriptionText: l?.description || tpl.description || null,
    fields: tpl.fields.map(f => ({ ...f, labelText: l?.fields?.[f.key] || f.label, optionLabels: f.options ? Object.fromEntries(f.options.map(o => [o, l?.options?.[o] || o])) : undefined })),
    sections: tpl.sections.map(s => ({ ...s, headingText: l?.sections?.[s.heading]?.[0] || s.heading, guidanceText: l?.sections?.[s.heading]?.[1] || s.guidance || null }))
  };
}

/** 章節在三種語言下的寫法（體檢比對必填章節時都算數）。 */
export function headingAliases(tpl, section) {
  const out = new Set([section.heading]);
  for (const l of Object.values(tpl.i18n || {})) if (l?.sections?.[section.heading]?.[0]) out.add(l.sections[section.heading][0]);
  return [...out].map(h => h.toLowerCase());
}

export const HINT_PREFIX = { 'zh-TW': '提示：', 'zh-CN': '提示：', en: 'Hint: ' };
export const HINT_RE = /<!--\s*(提示[：:]|Hint:)/i;

/** 按模板生成正文骨架：每個章節一個 ##，提示寫成 HTML 註釋（預覽不顯示，發布前體檢會提醒）。 */
export function skeleton(tpl, locale = currentLocale()) {
  const view = localizeTemplate(tpl, locale);
  return view.sections.map(s => `## ${s.headingText}\n\n${s.guidanceText ? `<!-- ${HINT_PREFIX[locale] || HINT_PREFIX['zh-TW']}${s.guidanceText} -->\n\n` : ''}`).join('');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/**
 * 校驗文檔的模板欄位。返回 { fields, problems, links }：fields 是規範化後的值；
 * problems 中格式錯誤一律是 error，缺少必填欄位在保存時是 warning、提交和發布時是 error；
 * links 是 link: true 的欄位選中的主體、客體、文檔（自動加入文檔的關聯）。
 */
export function checkFields(tpl, input, { store, docs, phase = 'save', locale = currentLocale() }) {
  const view = localizeTemplate(tpl, locale);
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = {};
  const problems = [];
  const links = { subjects: [], objects: [], related: [] };
  const known = new Set(tpl.fields.map(f => f.key));
  for (const k of Object.keys(values)) if (!known.has(k)) problems.push({ rule: 'D4', level: 'warning', field: k, message: tr('模板 {template} 沒有欄位 {key}，已忽略', { template: tpl.id, key: k }) });
  for (const f of view.fields) {
    let v = values[f.key];
    const label = f.labelText;
    const err = message => problems.push({ rule: 'D4', level: 'error', field: f.key, message });
    if (isEmpty(v)) {
      if (f.required) problems.push({ rule: 'D4', level: phase === 'save' ? 'warning' : 'error', field: f.key, message: tr('缺少必填欄位「{label}」', { label }) });
      continue;
    }
    const many = ['subjects', 'objects', 'enums'].includes(f.type);
    if (many) v = (Array.isArray(v) ? v : String(v).split(/[,，、]/)).map(x => String(x).trim()).filter(Boolean);
    switch (f.type) {
      case 'text': case 'person':
        v = String(v).trim();
        if (v.length > 200) err(tr('欄位「{label}」最長 200 字', { label }));
        break;
      case 'longtext':
        v = String(v);
        break;
      case 'number':
        if (!Number.isFinite(Number(v))) err(tr('欄位「{label}」必須是數字', { label }));
        else v = Number(v);
        break;
      case 'date':
        v = String(v).trim();
        if (!validDate(v)) err(tr('欄位「{label}」必須是日期 YYYY-MM-DD', { label }));
        break;
      case 'url':
        v = String(v).trim();
        if (!/^https?:\/\/\S+$/i.test(v)) err(tr('欄位「{label}」必須是 http 或 https 鏈接', { label }));
        break;
      case 'enum':
        v = String(v).trim();
        if (!f.options.includes(v)) err(tr('欄位「{label}」必須是以下之一：{list}', { label, list: f.options.join(tr('、')) }));
        break;
      case 'enums':
        for (const x of v) if (!f.options.includes(x)) err(tr('欄位「{label}」必須是以下之一：{list}', { label, list: f.options.join(tr('、')) }));
        break;
      case 'subject': case 'subjects': {
        const ids = many ? v : [String(v).trim()];
        for (const id of ids) {
          const s = store.subjects.get(id);
          if (!s) err(tr('欄位「{label}」：主體 {id} 不存在', { label, id }));
          else if (f.subjectTypes?.length && !f.subjectTypes.includes(s.type)) err(tr('欄位「{label}」要求主體類型 {types}；{id} 是 {type}', { label, types: f.subjectTypes.join(tr('、')), id, type: s.type }));
          else if (f.link) links.subjects.push(id);
        }
        if (!many) v = ids[0];
        break;
      }
      case 'object': case 'objects': {
        const ids = many ? v : [String(v).trim()];
        for (const id of ids) {
          const o = store.objects.get(id);
          if (!o) err(tr('欄位「{label}」：客體 {id} 不存在', { label, id }));
          else if (f.objectCategories?.length && !f.objectCategories.includes(o.category)) err(tr('欄位「{label}」要求客體類別 {categories}；{id} 是 {category}', { label, categories: f.objectCategories.join(tr('、')), id, category: o.category }));
          else if (f.link) links.objects.push(id);
        }
        if (!many) v = ids[0];
        break;
      }
      case 'doc':
        v = String(v).trim();
        if (!docs.has(v)) err(tr('欄位「{label}」：文檔 {id} 不存在', { label, id: v }));
        else if (f.link) links.related.push(v);
        break;
      default:
        break;
    }
    fields[f.key] = v;
  }
  return { fields, problems, links };
}

