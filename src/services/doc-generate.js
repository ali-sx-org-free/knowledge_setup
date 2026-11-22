// 從知識生成文檔（設計 §9.4）：把一個主體或一個領域的知識卡渲染成可讀的「主體手冊」。
// 正文寫入知識倉庫，一律用繁體原文；正文不含日期，hash 只隨知識變化，用來判斷手冊是否落後於知識。
// 層級寫在正文裡（Git 中、導出後也看得到）；後台渲染時引用標籤另外顯示當前層級。
import crypto from 'node:crypto';

const LEVEL_TEXT = { L0: 'L0 可靠', L1: 'L1 參考（未經驗證）', L2: 'L2 探索（不作結論）', E1: 'E1 已失效' };
const TYPE_ORDER = ['定義', '規則', '約束', '屬性'];
const SUBJECT_TYPE_ORDER = ['系統', '業務對象', '流程', '規則', '指標'];
const NOTE = '> 本手冊由知識庫自動生成，正文只讀；知識變化後在文檔頁點「重新生成」。L0 可直接作為依據；L1 未經驗證；L2 只供拓展思路，不作結論；已失效（E1）的知識單獨列出，不得作為依據。';

const one = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const hashOf = body => crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);

/** 返回 { title, summary, body, subjects, related, domain, hash }。 */
export function renderHandbook(store, lib, { kind, target }) {
  return kind === 'domain' ? domainHandbook(store, lib, target) : subjectHandbook(store, lib, target);
}

function relatedDocs(lib, subjectId) {
  return lib.documentsFor(subjectId).filter(d => !lib.docs.get(d.id)?.pub?.meta.generated && d.status === '已發布');
}

function subjectHandbook(store, lib, subjectId) {
  const card = store.card(subjectId);
  const s = card.subject;
  if (!card.assertions) throw new Error(`${subjectId} is an alias`);
  const out = [NOTE, '', '## 概述', ''];
  out.push(`[[${s.id}]] · ${s.type} · 領域 ${s.domain} · 綜合層級 ${s.level}`);
  out.push('');
  out.push(s.definition ? one(s.definition) : '（主體尚未登記定義。）');
  out.push('');
  const facts = [];
  if (card.aliases?.length) facts.push(`- 別名：${card.aliases.map(a => `${a.name}（[[${a.id}]]${a.ambiguous ? '，多義' : ''}）`).join('、')}`);
  if (s.owner) facts.push(`- 負責人：${s.owner}`);
  facts.push(`- 出錯代價：${s.errorCost}/5`);
  out.push(...facts, '');

  out.push('## 斷言', '');
  const valid = card.assertions.filter(a => a.level !== 'E1');
  if (!valid.length) out.push('（還沒有有效的斷言。）', '');
  const types = [...TYPE_ORDER, ...new Set(valid.map(a => a.type).filter(x => !TYPE_ORDER.includes(x)))];
  for (const type of types) {
    const list = valid.filter(a => a.type === type).sort((a, b) => a.level.localeCompare(b.level) || a.id.localeCompare(b.id));
    if (!list.length) continue;
    out.push(`### ${type}`, '');
    for (const a of list) out.push(`- ${one(a.content)}${a.structured ? `（\`${a.structured.key} = ${a.structured.value}\`）` : ''}〔[[${a.id}]] · ${LEVEL_TEXT[a.level]}〕`);
    out.push('');
  }
  const e1 = card.assertions.filter(a => a.level === 'E1');
  if (e1.length) {
    out.push('### 已失效（不得作為依據）', '');
    for (const a of e1) out.push(`- ~~${one(a.content)}~~〔[[${a.id}]] · E1〕${a.invalidReason ? `失效原因：${one(a.invalidReason)}` : ''}${a.replacedBy ? `；替代者 [[${a.replacedBy}]]` : ''}`);
    out.push('');
  }

  out.push('## 關係', '');
  const rels = [...card.relations.outgoing, ...card.relations.incoming].filter(r => r.level !== 'E1' && r.type !== '別名');
  if (!rels.length) out.push('（還沒有關係。）');
  for (const r of rels.sort((a, b) => a.level.localeCompare(b.level) || a.id.localeCompare(b.id))) out.push(`- [[${r.from.id}]] ${r.type} [[${r.to.id}]]〔[[${r.id}]] · ${LEVEL_TEXT[r.level]}〕`);
  out.push('');

  out.push('## 客體與依據', '');
  const binds = card.bindings.filter(b => b.level !== 'E1');
  if (!binds.length) out.push('（還沒有有效的客體綁定。）');
  for (const b of binds.sort((a, b2) => a.level.localeCompare(b2.level) || a.id.localeCompare(b2.id))) {
    const o = b.object || {};
    const doc = o.docId ? `，由文檔 [[${o.docId}]] 管理` : '';
    out.push(`- [[${o.id}]] ${one(o.name)}（${o.category || '—'}${o.kind ? ` · ${o.kind}` : ''}${o.locator && !o.docId ? ` · \`${o.locator}\`` : ''}${doc}）〔[[${b.id}]] · ${LEVEL_TEXT[b.level]}〕`);
  }
  out.push('');

  out.push('## 相關文檔', '');
  const docs = relatedDocs(lib, s.id);
  if (!docs.length) out.push('（還沒有相關文檔。）');
  for (const d of docs) out.push(`- [[${d.id}]] ${d.title}（${d.relation === 'binding' ? '以它為依據' : '講到了這個主體'}）`);
  out.push('');

  out.push('## 可用 Action', '');
  if (!card.actions.length) out.push('（沒有可用的 Action。）');
  for (const a of card.actions) out.push(`- ${a.id} ${a.name}（${a.kind}）${a.kind === '取值' ? '：動態值以實時取值為準，手冊不寫數值' : ''}`);
  out.push('');

  const body = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  const top = valid.find(a => a.type === '定義' && a.level === 'L0') || valid.find(a => a.type === '定義');
  const summary = one(`${s.name}的知識手冊：${s.definition || top?.content || `${s.type}，${valid.length} 條斷言`}`).slice(0, 200);
  return { title: `${s.name} 主體手冊`, summary, body, subjects: [s.id], related: docs.map(d => d.id), domain: s.domain, hash: hashOf(body) };
}

function domainHandbook(store, lib, code) {
  const domain = store.config.domains.find(d => d.code === code);
  const subjects = [...store.subjects.values()].filter(s => s.domain === code && s.type !== '別名').sort((a, b) => a.id.localeCompare(b.id));
  const out = [NOTE, '', '## 概述', ''];
  const levels = { L0: 0, L1: 0, L2: 0 };
  for (const s of subjects) levels[store.subjectLevel(s)]++;
  out.push(`領域 ${code}（${domain?.name || code}）共 ${subjects.length} 個主體：L0 ${levels.L0} · L1 ${levels.L1} · L2 ${levels.L2}。每個主體列出定義和有效的定義、規則、約束類斷言；完整內容見各主體的手冊或知識卡。`, '');
  const types = [...SUBJECT_TYPE_ORDER, ...new Set(subjects.map(s => s.type).filter(t => !SUBJECT_TYPE_ORDER.includes(t)))];
  for (const type of types) {
    const list = subjects.filter(s => s.type === type);
    if (!list.length) continue;
    out.push(`## ${type}`, '');
    for (const s of list) {
      out.push(`### ${s.name}`, '');
      out.push(`[[${s.id}]] · 綜合層級 ${store.subjectLevel(s)}${s.definition ? `：${one(s.definition)}` : ''}`, '');
      const key = s.assertions.filter(a => a.validity.level !== 'E1' && a.type !== '屬性').sort((a, b) => a.validity.level.localeCompare(b.validity.level) || a.id.localeCompare(b.id));
      for (const a of key) out.push(`- ${a.type}：${one(a.content)}〔[[${a.id}]] · ${LEVEL_TEXT[a.validity.level]}〕`);
      if (key.length) out.push('');
    }
  }
  const body = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  const name = domain?.name || code;
  return { title: `${name}領域手冊`, summary: `${name}領域（${code}）${subjects.length} 個主體的定義與關鍵知識，由知識庫自動生成。`, body, subjects: [], related: [], domain: code, hash: hashOf(body) };
}
