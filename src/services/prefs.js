// 每個登入身份的後台偏好與「我的視圖」：存在服務本地 DATA_DIR/prefs/，按身份分開，換瀏覽器也在（設計 §10、§17 第 4 條）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../api/auth.js';
import { tr } from '../i18n/index.js';

export const VIEW_SCOPES = ['subjects', 'assertions', 'objects', 'relations', 'queue', 'docs'];
const MAX_VIEWS = 50;
const PREF_KEYS = { ownerName: 'string', singleKeys: 'boolean', railNav: 'boolean' };

const invalid = message => new HttpError(400, message, 'invalid_input');

export class Prefs {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(principal) {
    return path.join(this.dir, `${crypto.createHash('sha1').update(String(principal.id)).digest('hex').slice(0, 16)}.json`);
  }

  read(principal) {
    if (!principal) return { prefs: {}, views: {} };
    const file = this.file(principal);
    if (!this.cache.has(file)) {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
      this.cache.set(file, { id: principal.id, prefs: data.prefs || {}, views: data.views || {} });
    }
    return this.cache.get(file);
  }

  write(principal, data) {
    const file = this.file(principal);
    const out = { id: principal.id, prefs: data.prefs || {}, views: data.views || {} };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    this.cache.set(file, out);
    return out;
  }

  /** 「我負責的」和批量改負責人的預設值用的名字：帳號設定裡填的名字，沒有時用帳號名稱。 */
  ownerName(principal) {
    return this.read(principal).prefs.ownerName || principal?.name || null;
  }

  updatePrefs(principal, patch = {}) {
    const cur = this.read(principal);
    const prefs = { ...cur.prefs };
    for (const [k, v] of Object.entries(patch)) {
      const type = PREF_KEYS[k];
      if (!type) continue;
      if (v === null || v === '') { delete prefs[k]; continue; }
      if (typeof v !== type) throw invalid(tr('{field} 必須為 {values}', { field: k, values: type }));
      if (type === 'string' && [...v.trim()].length > 40) throw invalid(tr('{field} 最長 {n} 字', { field: k, n: 40 }));
      prefs[k] = type === 'string' ? v.trim() : v;
    }
    return this.write(principal, { ...cur, prefs }).prefs;
  }

  setViews(principal, scope, views) {
    if (!VIEW_SCOPES.includes(scope)) throw invalid(tr('{field} 必須為 {values}', { field: 'scope', values: VIEW_SCOPES.join(' / ') }));
    if (!Array.isArray(views)) throw invalid(tr('{field} 必須為陣列', { field: 'views' }));
    if (views.length > MAX_VIEWS) throw invalid(tr('每個列表最多保存 {n} 個視圖', { n: MAX_VIEWS }));
    const ids = new Set();
    const clean = views.map(v => {
      const name = String(v?.name ?? '').trim();
      const query = String(v?.query ?? '');
      if (!name || [...name].length > 40) throw invalid(tr('視圖名稱必填，最長 {n} 字', { n: 40 }));
      if (query.length > 2000) throw invalid(tr('視圖條件過長'));
      let id = String(v?.id || '').replace(/[^\w-]/g, '').slice(0, 24) || crypto.randomBytes(4).toString('hex');
      while (ids.has(id)) id = crypto.randomBytes(4).toString('hex');
      ids.add(id);
      // layout：保存視圖時的欄位與密度（cols=…&density=…），只影響顯示
      const layout = typeof v?.layout === 'string' ? v.layout.slice(0, 500) : '';
      return { id, name, query, ...(layout ? { layout } : {}), ...(v.default ? { default: true } : {}) };
    });
    if (clean.filter(v => v.default).length > 1) throw invalid(tr('只能有一個預設視圖'));
    const cur = this.read(principal);
    return this.write(principal, { ...cur, views: { ...cur.views, [scope]: clean } }).views;
  }
}
