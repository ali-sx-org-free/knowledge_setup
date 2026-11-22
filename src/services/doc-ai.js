// 文檔與知識的雙向生成（設計 §9.4）：AI 起草、按章節建議斷言。
// AI 起草：選模板、寫要求、選主體；內容只取這些主體 L0、L1 的知識並以 [[ID]] 附引用。結果是草稿，標記「AI 起草」，必須由人發布。
// 有 OpenRouter 時由模型按模板組織；沒有配置（或 compose=template）時按章節提示和標題把知識填進骨架，填不了的章節保留提示。
// 建議斷言：把已發布文檔的句子按章節的 knowledge 提示和句式猜出斷言類型，按 [[S-…]] 引用或術語解析找到主體；只是建議，寫入走 extractAssertions。
import { RuleError } from '../store/validity.js';
import { ASSERTION_TYPES } from '../store/model.js';
import { localizeTemplate, skeleton, headingAliases, HINT_PREFIX } from '../store/doc-templates.js';
import { parseSections, plainText, REF_RE } from '../../web/assets/markdown.js';
import { tr, currentLocale } from '../i18n/index.js';

const fail = (status, code, message) => new RuleError(message, status, code);
const clean = v => (typeof v === 'string' ? v.trim() : v);
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const LANGUAGE = { 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', en: '英文（English）' };
const MAX_SUBJECTS = 10;

// 章節標題 → 該填哪類知識（模板沒有 knowledge 提示時用）。順序即優先級。
const HEADING_RULES = [
  { re: /定義|定义|概述|概要|簡介|简介|是什麼|是什么|含義|含义|definition|overview|summary|introduction/i, fill: 'definition' },
  { re: /公式|計算|计算|口徑|口径|formula|calculat/i, fill: 'formula' },
  { re: /規則|规则|規定|规定|流程|步驟|步骤|做法|處理|处理|rule|procedure|step|process/i, fill: ['規則'] },
  { re: /約束|约束|限制|邊界|边界|例外|注意|風險|风险|constraint|limit|edge|exception|caution|risk/i, fill: ['約束'] },
  { re: /屬性|属性|參數|参数|配置|設定|设定|attribute|parameter|config|setting/i, fill: ['屬性'] },
  { re: /數據|数据|來源|来源|客體|客体|依據|依据|接口|系統|系统|data|source|object|interface/i, fill: 'objects' },
  { re: /相關|相关|關係|关系|上下游|related|relation|depend/i, fill: 'relations' },
  // 留給作者寫的章節：不填知識
  { re: /變更|变更|修訂|修订|歷史|历史|決定|决定|示例|例子|常見問題|常见问题|問答|问答|待決|待决|change|history|decision|example|faq|question/i, fill: 'skip' },
  // 其餘說明類章節：放其他還沒用上的斷言
  { re: /詳細|详细|說明|说明|內容|内容|要點|要点|details|description|content|notes/i, fill: ['規則', '約束', '屬性', '定義'] }
];

const LEVEL_MARK = { L0: '', L1: '（未經驗證）' };
// 「計算公式」一類章節，和像公式的定義斷言（含 = ÷ × 等）
const FORMULA_HEADING = /公式|計算|计算|formula|calculat/i;
const FORMULA_CONTENT = /[=＝÷×]/;

/** 章節該填哪類知識：模板的 knowledge 提示優先；「定義」提示按標題分成定義和公式兩種填法。 */
function sectionRule(sec) {
  const byHeading = HEADING_RULES.find(r => r.re.test(sec.heading) || r.re.test(sec.headingText));
  if (!sec.knowledge) return byHeading;
  if (sec.knowledge === '定義') return { fill: FORMULA_HEADING.test(sec.heading) || FORMULA_HEADING.test(sec.headingText) ? 'formula' : 'definition' };
  return { fill: [sec.knowledge] };
}

/** 主體在起草時可用的知識：只取 L0、L1。 */
function knowledgeOf(store, subjectId) {
  const card = store.card(subjectId);
  const ok = x => x.level === 'L0' || x.level === 'L1';
  return {
    subject: card.subject,
    assertions: card.assertions.filter(ok).map(a => ({ id: a.id, type: a.type, content: one(a.content), structured: a.structured || null, level: a.level })),
    relations: [...card.relations.outgoing, ...card.relations.incoming].filter(r => ok(r) && r.type !== '別名').map(r => ({ id: r.id, type: r.type, from: r.from?.id, fromName: r.from?.name, to: r.to?.id, toName: r.to?.name, level: r.level })),
    bindings: card.bindings.filter(ok).map(b => ({ id: b.id, objectId: b.object?.id, name: b.object?.name, category: b.object?.category, kind: b.object?.kind || null, locator: b.object?.docId ? null : b.object?.locator || null, level: b.level }))
  };
}

/** 起草時用到的主體：別名換成它指向的規範主體；最多 10 個。 */
function resolveSubjects(store, ids) {
  const out = [];
  for (const raw of ids) {
    const s = store.getSubject(raw);
    const targets = s.type === '別名' ? store.aliasTargets(s) : [s.id];
    if (s.type === '別名' && targets.length !== 1) throw fail(422, 'invalid_input', tr('{id} 是多義別名，請直接選它指向的規範主體', { id: s.id }));
    for (const id of targets) if (!out.includes(id)) out.push(id);
  }
  if (!out.length) throw fail(400, 'invalid_input', tr('AI 起草至少要選一個主體：內容只取這些主體的知識'));
  if (out.length > MAX_SUBJECTS) throw fail(400, 'invalid_input', tr('AI 起草最多選 {n} 個主體', { n: MAX_SUBJECTS }));
  return out;
}

/** 模型返回的正文：只保留知識庫裡存在的 [[ID]]，返回 { text, stripped }。 */
function keepKnownRefs(store, text) {
  let stripped = 0;
  const out = String(text || '').replace(REF_RE, (all, id) => {
    if (store.subjects.has(id) || store.objects.has(id) || store.docs.docs.has(id) || store.actions.has(id) || store.assertionIndex.has(id) || store.bindingIndex.has(id) || store.relations.has(id)) return all;
    stripped++;
    return '';
  });
  return { text: out, stripped };
}

/** 模板欄位裡可以直接填的：主體類欄位按主體類型取選中的主體。 */
function prefillFields(tpl, store, subjectIds) {
  const fields = {};
  for (const f of tpl.fields || []) {
    if (!['subject', 'subjects'].includes(f.type)) continue;
    const fit = subjectIds.filter(id => !f.subjectTypes?.length || f.subjectTypes.includes(store.subjects.get(id)?.type));
    if (!fit.length) continue;
    fields[f.key] = f.type === 'subject' ? fit[0] : fit;
  }
  return fields;
}

const itemLine = a => `- ${a.content}${a.structured ? `（\`${a.structured.key} = ${a.structured.value}\`）` : ''}${LEVEL_MARK[a.level] || ''} [[${a.id}]]`;

export class DocAi {
  constructor({ store, llm, logger = console }) {
    this.store = store;
    this.llm = llm;
    this.logger = logger;
  }

  /**
   * AI 起草（不寫入）：返回 { template, title, folder, summary, body, fields, subjects, aiDraft, warnings }。
   * 寫入由路由在一個事務裡調用 lib.create(..., { aiDraft })。
   */
  async draft(input = {}, principal) {
    const st = this.store;
    st.assertCanContribute(principal);
    const lib = st.docs;
    const tpl = lib.getTemplate(clean(input.template) || 'TPL-0001');
    if (tpl.generator) throw fail(422, 'invalid_input', tr('模板「{name}」由知識自動生成，不能用來起草；請在主體或文檔庫頁點「生成手冊」', { name: tpl.name }));
    const instruction = one(input.instruction).slice(0, 1000);
    const ids = resolveSubjects(st, (Array.isArray(input.subjectIds) ? input.subjectIds : String(input.subjectIds || '').split(/[,，\s]+/)).map(x => String(x).trim()).filter(Boolean));
    const knowledge = ids.map(id => knowledgeOf(st, id));
    const compose = ['auto', 'llm', 'template'].includes(input.compose) ? input.compose : 'auto';
    const warnings = [];
    let result = null;
    let composer = { type: 'template' };
    if (compose === 'llm' || (compose === 'auto' && this.llm?.enabled)) {
      try {
        result = await this.llmDraft({ tpl, instruction, knowledge, title: clean(input.title), model: clean(input.model) || undefined });
        composer = { type: 'openrouter', model: result.model };
        if (result.stripped) warnings.push(tr('模型寫了 {n} 個知識庫裡不存在的引用，已刪除', { n: result.stripped }));
      } catch (err) {
        if (compose === 'llm') throw fail(502, 'llm_error', tr('AI 起草失敗：{error}', { error: err.message }));
        composer = { type: 'template', fallbackReason: err.message };
        warnings.push(tr('模型不可用，改為按模板填入知識：{error}', { error: err.message }));
      }
    }
    if (!result) result = this.templateDraft({ tpl, instruction, knowledge });
    const names = knowledge.map(k => k.subject.name);
    const title = clean(input.title) || `${names[0]}${/^[A-Za-z0-9]/.test(tpl.name) || /[A-Za-z0-9]$/.test(names[0]) ? ' ' : ''}${tpl.name}`;
    const aiDraft = { composer: composer.type, ...(composer.model ? { model: composer.model } : {}), instruction: instruction || null, subjects: ids, at: new Date().toISOString(), by: principal.id };
    const empty = knowledge.every(k => !k.assertions.length && !k.relations.length && !k.bindings.length && !k.subject.definition);
    if (empty) warnings.push(tr('選中的主體還沒有 L0、L1 的知識，草稿只有骨架'));
    return {
      template: tpl.id, title, folder: clean(input.folder) || null, summary: result.summary || null, body: result.body,
      fields: prefillFields(tpl, st, ids), subjects: ids, aiDraft, composer, warnings, filled: result.filled ?? null
    };
  }

  /** 沒有模型時：按章節的 knowledge 提示與標題把知識放進骨架，每條知識只用一次。 */
  templateDraft({ tpl, instruction, knowledge }) {
    const locale = currentLocale();
    const view = localizeTemplate(tpl, locale);
    const used = new Set();
    const hint = HINT_PREFIX[locale] || HINT_PREFIX['zh-TW'];
    const take = list => list.filter(x => !used.has(x.id)).map(x => { used.add(x.id); return x; });
    const multi = knowledge.length > 1;
    const group = (k, lines) => (multi && lines.length ? [`**[[${k.subject.id}]]**`, '', ...lines, ''] : lines.length ? [...lines, ''] : []);
    let filled = 0;
    const parts = [];
    parts.push(`<!-- ${hint}${tr('本稿由模板按知識自動起草（沒有使用模型）：每條內容後面是知識的引用，「未經驗證」的是 L1 知識。請核對、補充後再發布。')}${instruction ? ` ${tr('起草要求：{text}', { text: instruction.replace(/-->/g, '→') })}` : ''} -->`, '');
    // 模板有公式章節時，像公式的定義斷言放進公式章節，定義章節只放文字定義
    const hasFormula = view.sections.some(sec => sectionRule(sec)?.fill === 'formula');
    const isFormula = a => a.type === '定義' && FORMULA_CONTENT.test(a.content);
    for (const sec of view.sections) {
      const rule = sectionRule(sec);
      const lines = [];
      if (rule && rule.fill !== 'skip') {
        for (const k of knowledge) {
          const sub = [];
          if (rule.fill === 'definition') {
            if (k.subject.definition && !used.has(k.subject.id)) { used.add(k.subject.id); sub.push(`- ${one(k.subject.definition)}${k.subject.level === 'L0' ? '' : LEVEL_MARK.L1} [[${k.subject.id}]]`); }
            sub.push(...take(k.assertions.filter(a => a.type === '定義' && !(hasFormula && isFormula(a)))).map(itemLine));
          } else if (rule.fill === 'formula') {
            sub.push(...take(k.assertions.filter(isFormula)).map(itemLine));
          } else if (rule.fill === 'objects') {
            for (const b of take(k.bindings)) sub.push(`- [[${b.objectId}]] ${b.name}（${b.category || '—'}${b.kind ? ` · ${b.kind}` : ''}${b.locator ? ` · \`${b.locator}\`` : ''}）${LEVEL_MARK[b.level] || ''} [[${b.id}]]`);
          } else if (rule.fill === 'relations') {
            for (const r of take(k.relations)) sub.push(`- [[${r.from}]] ${r.type} [[${r.to}]]${LEVEL_MARK[r.level] || ''} [[${r.id}]]`);
          } else {
            sub.push(...take(k.assertions.filter(a => rule.fill.includes(a.type))).map(itemLine));
          }
          lines.push(...group(k, sub));
        }
      }
      parts.push(`## ${sec.headingText}`, '');
      if (lines.length) { filled++; parts.push(...lines); }
      else if (sec.guidanceText) parts.push(`<!-- ${hint}${sec.guidanceText} -->`, '');
    }
    // 沒有放進任何章節的 L0、L1 斷言：放在最後一個單獨的章節，提醒作者歸位或刪除
    const rest = knowledge.flatMap(k => k.assertions.filter(a => !used.has(a.id)));
    if (rest.length) {
      parts.push(`## ${tr('其他相關知識（請歸位或刪除）')}`, '', `<!-- ${hint}${tr('以下知識沒有對應的章節，請移到合適的章節或刪除：')} -->`, '');
      parts.push(...rest.map(itemLine), '');
    }
    const top = knowledge[0];
    const def = top.assertions.find(a => a.type === '定義' && a.level === 'L0') || top.assertions.find(a => a.type === '定義');
    return { body: `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, summary: one(top.subject.definition || def?.content || '').slice(0, 200) || null, filled };
  }

  async llmDraft({ tpl, instruction, knowledge, title, model }) {
    const view = localizeTemplate(tpl, currentLocale());
    const sections = view.sections.map(s => ({ heading: s.headingText, guidance: s.guidanceText || null, knowledgeType: s.knowledge || null }));
    const system = [
      '你是「供應鏈技術知識體系」的文檔起草助手。按用戶給的模板章節起草一篇文檔草稿，嚴格遵守：',
      '1. 只能使用 knowledge 中的內容，不得用行業通用知識、常識或猜測補全；knowledge 沒有的內容就不寫，章節沒有內容時 body 留空字串。',
      '2. 每一句陳述後面用 [[ID]] 標註依據，ID 必須來自 knowledge（斷言 A-、關係 R-、綁定 B-、主體 S-、客體 O-）。提到主體時用 [[S-…]]。',
      '3. L1 知識必須寫明「未經驗證」；L0 可以直接陳述。',
      '4. 不寫任何數量、狀態等動態值；knowledge 裡的數值按原文引用。',
      `5. 用起草要求的語言寫作；無法判斷時用${LANGUAGE[currentLocale()] || '繁體中文'}。章節標題原樣使用 sections 中的 heading，不新增章節。`,
      '6. 正文用 Markdown（列表、表格、粗體），不要寫一級、二級標題（章節標題由系統加）。',
      '輸出 JSON：{"summary": string, "sections": [{"heading": string, "body": string}]}'
    ].join('\n');
    const user = JSON.stringify({ template: { name: view.label, description: view.descriptionText }, title: title || null, instruction: instruction || null, sections, knowledge });
    const r = await this.llm.chatJson({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 2500 });
    const list = Array.isArray(r.json?.sections) ? r.json.sections : null;
    if (!list) throw new Error(tr('模型未返回有效 JSON'));
    const byHeading = new Map(list.filter(x => x && typeof x.heading === 'string').map(x => [x.heading.trim().toLowerCase(), String(x.body || '').trim()]));
    let stripped = 0;
    let filled = 0;
    const hint = HINT_PREFIX[currentLocale()] || HINT_PREFIX['zh-TW'];
    const parts = [`<!-- ${hint}${tr('本稿由 AI 按知識起草：請核對每條引用、補充缺少的內容後再發布。')} -->`, ''];
    for (const sec of view.sections) {
      const keys = [sec.headingText, ...headingAliases(tpl, sec)].map(h => h.toLowerCase());
      const raw = keys.map(k => byHeading.get(k)).find(v => v !== undefined) || '';
      const cleaned = keepKnownRefs(this.store, raw.replace(/^#{1,2}\s.*$/gm, '').trim());
      stripped += cleaned.stripped;
      parts.push(`## ${sec.headingText}`, '');
      if (cleaned.text.trim()) { filled++; parts.push(cleaned.text.trim(), ''); }
      else if (sec.guidanceText) parts.push(`<!-- ${hint}${sec.guidanceText} -->`, '');
    }
    return { body: `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, summary: one(r.json.summary).slice(0, 200) || null, model: r.model, stripped, filled };
  }

  // ------------------------------------------------------------ 建議斷言
  /**
   * 按章節建議可提取的斷言（不寫入）。只看已發布版本；anchor 限定一個章節。
   * 返回 { docId, version, items: [{ anchor, heading, subjectId, subjectName, type, content, exists, reason }], composer }。
   */
  async suggestAssertions(docId, input = {}, principal) {
    const st = this.store;
    st.assertCanContribute(principal);
    const lib = st.docs;
    const doc = lib.get(docId);
    const m = doc.pub?.meta;
    if (!m || m.status !== '已發布') throw fail(409, 'not_published', tr('{id} 還沒有發布：只能從已發布的版本提取斷言', { id: docId }));
    if (m.generated) throw fail(409, 'generated_doc', tr('{id} 由知識生成，不能再作為知識的證據', { id: docId }));
    const tpl = lib.templates.get(m.template);
    let sections = parseSections(doc.pub.body).filter(s => s.text);
    const anchor = clean(input.anchor);
    if (anchor) sections = sections.filter(s => s.anchor === anchor || s.heading === anchor);
    // 選中的一段文字：只分析這段，章節取 anchor 指的（或包含這段文字的）章節
    const text = clean(input.text) ? String(input.text).slice(0, 2000) : null;
    if (text) {
      const plain = one(text);
      const sec = sections.find(x => one(x.text).includes(plain.slice(0, 40))) || sections[0] || null;
      sections = [{ anchor: sec?.anchor || '', heading: sec?.heading || '', text }];
    }
    const compose = text ? 'template' : ['auto', 'llm', 'template'].includes(input.compose) ? input.compose : 'template';
    const limit = Math.min(50, Number(input.limit) || 30);
    let items = null;
    let composer = { type: 'rule' };
    if (compose === 'llm' || (compose === 'auto' && this.llm?.enabled)) {
      try {
        const r = await this.llmSuggest({ doc, tpl, sections, limit });
        items = r.items;
        composer = { type: 'openrouter', model: r.model };
      } catch (err) {
        if (compose === 'llm') throw fail(502, 'llm_error', tr('AI 建議失敗：{error}', { error: err.message }));
        composer = { type: 'rule', fallbackReason: err.message };
      }
    }
    if (!items) items = this.ruleSuggest({ doc, tpl, sections });
    if (text && !items.length) {
      const linked = m.subjects.filter(id => st.subjects.get(id)?.type !== '別名');
      const content = plainSentence(st, text).slice(0, 500);
      items = [{ anchor: sections[0]?.anchor || '', heading: sections[0]?.heading || '', subjectId: linked[0] || null, type: sectionKnowledge(tpl, sections[0]?.heading) || guessType(content), content, reason: linked[0] ? 'linked' : null }];
    }
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = `${it.subjectId}|${normalizeText(it.content)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = st.subjects.get(it.subjectId);
      out.push({ ...it, subjectName: s?.name || null, exists: !!s?.assertions.some(a => a.validity.level !== 'E1' && normalizeText(a.content) === normalizeText(it.content)) });
      if (out.length >= limit) break;
    }
    return { docId, version: m.version, objectId: m.objectId || null, items: out, composer };
  }

  ruleSuggest({ doc, tpl, sections }) {
    const st = this.store;
    const linked = doc.pub.meta.subjects.filter(id => st.subjects.get(id) && st.subjects.get(id).type !== '別名');
    const out = [];
    for (const sec of sections) {
      const hintType = sectionKnowledge(tpl, sec.heading);
      for (const raw of sentencesOf(sec.text)) {
        const refs = [...raw.matchAll(REF_RE)].map(x => x[1]).filter(id => st.subjects.get(id) && st.subjects.get(id).type !== '別名');
        const content = plainSentence(st, raw);
        if ([...content].length < 6 || [...content].length > 300 || /[：:]$/.test(raw.trim())) continue;
        let subjectId = refs[0] || null;
        let reason = subjectId ? 'ref' : null;
        if (!subjectId) {
          const r = st.resolveTerms(content);
          subjectId = r.canonical.find(id => st.subjects.get(id)?.type !== '別名') || null;
          if (subjectId) reason = 'term';
        }
        if (!subjectId && linked.length === 1) { subjectId = linked[0]; reason = 'linked'; }
        if (!subjectId) continue;
        out.push({ anchor: sec.anchor, heading: sec.heading, subjectId, type: hintType || guessType(content), content, reason });
      }
    }
    return out;
  }

  async llmSuggest({ doc, tpl, sections, limit }) {
    const st = this.store;
    const ids = new Set(doc.pub.meta.subjects);
    for (const s of sections) for (const x of s.text.matchAll(REF_RE)) if (st.subjects.has(x[1])) ids.add(x[1]);
    for (const id of st.resolveTerms(sections.map(s => s.text).join('\n')).canonical) ids.add(id);
    const subjects = [...ids].map(id => st.subjects.get(id)).filter(s => s && s.type !== '別名').slice(0, 40).map(s => ({ id: s.id, name: s.name, type: s.type }));
    if (!subjects.length) return { items: [], model: null };
    const system = [
      '你負責從一篇已發布的文檔中找出可以登記為「斷言」的陳述。斷言是關於某個主體的一句話事實，類型為：' + Object.entries(ASSERTION_TYPES).map(([k, v]) => `${k}（${v}）`).join('；'),
      '規則：只摘錄文檔原文已經寫明的內容，可以去掉口語和引用標記，但不得改變意思、不得補充；每條只說一件事；主體只能從 subjects 中選；章節有 knowledgeType 時優先用它。',
      `最多 ${limit} 條。輸出 JSON：{"items": [{"heading": string, "subjectId": string, "type": string, "content": string}]}`
    ].join('\n');
    const user = JSON.stringify({ doc: { id: doc.id, title: doc.pub.meta.title }, subjects, sections: sections.map(s => ({ heading: s.heading, knowledgeType: sectionKnowledge(tpl, s.heading), text: s.text.slice(0, 2000) })) });
    const r = await this.llm.chatJson({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 2000 });
    if (!Array.isArray(r.json?.items)) throw new Error(tr('模型未返回有效 JSON'));
    const byHeading = new Map(sections.map(s => [s.heading, s]));
    const items = r.json.items
      .filter(x => x && subjects.some(s => s.id === x.subjectId) && ASSERTION_TYPES[x.type] && typeof x.content === 'string' && byHeading.has(x.heading))
      .map(x => ({ anchor: byHeading.get(x.heading).anchor, heading: x.heading, subjectId: x.subjectId, type: x.type, content: one(plainSentence(st, x.content)).slice(0, 500), reason: 'llm' }));
    return { items, model: r.model };
  }
}

/** 章節的 knowledge 提示（按模板章節名的三種寫法比對）。 */
export function sectionKnowledge(tpl, heading) {
  if (!tpl) return null;
  const h = String(heading || '').trim().toLowerCase();
  return tpl.sections.find(s => s.knowledge && headingAliases(tpl, s).includes(h))?.knowledge || null;
}

const normalizeText = s => String(s || '').replace(/[\s，。、；：,.;:！!？?（）()「」『』"'“”‘’]/g, '').toLowerCase();

/** 把章節正文切成句子：列表項、表格行各算一句；段落按句號、分號切。代碼塊和註釋不算。 */
export function sentencesOf(text) {
  const out = [];
  let fence = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence || !line.trim() || /^\s*\|?\s*:?-{3,}/.test(line) || /^\s*<!--/.test(line) || /^\s*!\[/.test(line)) continue;
    const item = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*>\s?/, '').trim();
    if (/^\|.*\|$/.test(item)) { out.push(item.split('|').map(c => c.trim()).filter(Boolean).join('，')); continue; }
    for (const s of item.split(/(?<=[。；！？!?;])\s*|(?<=\.)\s+(?=[A-Z])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/** 句子轉為斷言內容：引用換成名稱，去掉 Markdown 標記和結尾的標點。 */
function plainSentence(store, s) {
  const named = String(s || '').replace(REF_RE, (all, id) => store.subjects.get(id)?.name || store.objects.get(id)?.name || id);
  return plainText(named).replace(/[。；;，,]+$/, '').replace(/\s+/g, ' ').replace(/(\p{Script=Han}) (?=\p{Script=Han})/gu, '$1').trim();
}

/** 按句式猜斷言類型。 */
export function guessType(s) {
  if (/不得|不能|不可|禁止|必須|必须|只能|不超過|不超过|上限|下限|至少|最多|不允許|不允许|must|cannot|can't|not allowed|at most|at least/i.test(s)) return '約束';
  if (/是指|指的是|定義為|定义为|即為|即为|等於|等于|＝|=|means|is defined|refers to/i.test(s)) return '定義';
  if (/如果|若|當.+時|当.+时|則|则|每|按|超過|超过|需要|應|应|先.+再|之後|之后|if |when |should|then/i.test(s)) return '規則';
  return '屬性';
}
