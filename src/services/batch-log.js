// 批量整理的撤銷記錄：每次批量（負責人、標籤、出錯代價、有效期）記下每個主體的原值與新值。
// 存在服務本地 DATA_DIR/batches/<倉庫>/，不進知識倉庫；撤銷時寫一個反向提交（設計 §8.4）。
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 500;
const safe = commit => String(commit || '').replace(/[^0-9a-f]/gi, '');

export class BatchLog {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(commit) {
    return path.join(this.dir, `${safe(commit)}.json`);
  }

  save(record) {
    const file = this.file(record.commit);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    this.prune();
    return record;
  }

  prune() {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    if (files.length <= KEEP) return;
    const dated = files.map(f => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { f } of dated.slice(0, files.length - KEEP)) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  /** 按提交雜湊（完整或前綴，兩邊長度可能不同）找記錄。 */
  get(commit) {
    const c = safe(commit);
    if (c.length < 4) return null;
    const name = fs.readdirSync(this.dir).find(f => f.endsWith('.json') && (f.startsWith(c) || c.startsWith(f.slice(0, -5))));
    if (!name) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return null; }
  }

  /** 提交雜湊 → 記錄摘要（變更記錄頁用來標出可撤銷的提交）。 */
  index() {
    const out = new Map();
    for (const f of fs.readdirSync(this.dir).filter(x => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        out.set(r.commit, { commit: r.commit, at: r.at, count: r.items.length, undoneBy: r.undoneBy || null });
      } catch { /* 損壞的記錄略過 */ }
    }
    return out;
  }

  find(index, hash) {
    for (const [commit, info] of index) if (commit.startsWith(hash) || hash.startsWith(commit)) return info;
    return null;
  }
}
