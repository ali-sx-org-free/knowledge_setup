// SSH 部署金鑰：後台產生（ed25519）或貼上私鑰，存在 DATA_DIR/ssh/（0600），不進入知識倉庫。
// 連接遠端時只用這把金鑰與服務自己的 known_hosts（首次連接記下主機指紋），不讀 ~/.ssh 與使用者的 ssh 設定。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEVNULL = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** git@host:path、ssh://… 與 git+ssh://… 視為 SSH 地址。 */
export function isSshUrl(url) {
  const u = String(url || '').trim();
  if (/^(?:git\+)?ssh:\/\//i.test(u)) return true;
  return !u.includes('://') && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S/.test(u);
}

/** GitHub 倉庫的「新增 Deploy key」頁面地址；不是 GitHub 時返回 null。 */
export function githubDeployKeyUrl(url) {
  const m = String(url || '').trim().match(/^(?:git@github\.com:|(?:git\+)?ssh:\/\/git@(?:ssh\.)?github\.com(?::\d+)?\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}/settings/keys/new` : null;
}

/** POSIX shell 單引號轉義（GIT_SSH_COMMAND 由 shell 解析；Windows 上 Git 也用自帶的 sh）。 */
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch { /* 下一個 */ }
    }
  }
  return null;
}

// ssh-keygen 不需要使用者環境；不給 DISPLAY / SSH_ASKPASS，有密碼的私鑰直接失敗而不是等待輸入。
const KEYGEN_ENV = Object.fromEntries(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]).concat([['SSH_ASKPASS_REQUIRE', 'never']]));

function keygen(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh-keygen', args, { timeout: 30000, env: KEYGEN_ENV }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || err.message).trim();
        reject(err);
      } else resolve(stdout);
    });
    child.stdin.end(input || '');
  });
}

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

export class SshKeys {
  /**
   * @param {object} opts
   * @param {string} opts.dir        金鑰與 known_hosts 存放目錄（DATA_DIR/ssh）
   * @param {string} [opts.keyFile]  由環境變數 KNOWLEDGE_GIT_SSH_KEY_FILE 指定的私鑰檔；設定後後台不能產生或替換
   */
  constructor({ dir, keyFile } = {}) {
    this.dir = dir;
    this.fromEnv = !!keyFile;
    this.keyFile = keyFile ? path.resolve(keyFile) : path.join(dir, 'deploy_key');
    this.knownHostsFile = path.join(dir, 'known_hosts');
    this.metaFile = path.join(dir, 'deploy_key.json');
  }

  available() {
    return !!(which('ssh') && which('ssh-keygen'));
  }

  hasKey() {
    return fs.existsSync(this.keyFile);
  }

  /** 供 GitRepo 使用：有金鑰時返回 git 需要的 ssh 命令，否則 null。 */
  sshCommand() {
    if (!this.hasKey()) return null;
    return ['ssh', '-F', DEVNULL, '-i', this.keyFile, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${this.knownHostsFile}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'].map(shq).join(' ');
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* Windows */ }
  }

  requireTools() {
    if (!which('ssh-keygen')) throw httpError(409, '這台伺服器沒有 ssh-keygen，無法使用 SSH 部署金鑰；請安裝 OpenSSH 客戶端', 'ssh_missing');
  }

  requireWritable() {
    if (this.fromEnv) throw httpError(409, '部署金鑰由環境變數 KNOWLEDGE_GIT_SSH_KEY_FILE 提供，無法在後台修改', 'ssh_key_from_env');
  }

  readMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      return {};
    }
  }

  writeMeta(meta) {
    fs.writeFileSync(this.metaFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  async publicKey() {
    if (!this.hasKey()) return null;
    try {
      const pub = (await fsp.readFile(`${this.keyFile}.pub`, 'utf8')).trim();
      if (pub) return pub;
    } catch { /* 從私鑰推導 */ }
    try {
      return (await keygen(['-y', '-f', this.keyFile])).trim() || null;
    } catch {
      return null;
    }
  }

  async fingerprint(publicKey) {
    if (!publicKey) return null;
    const tmp = path.join(os.tmpdir(), `kb-pub-${process.pid}-${Date.now()}.pub`);
    try {
      await fsp.writeFile(tmp, publicKey + '\n');
      return (await keygen(['-l', '-f', tmp])).trim();
    } catch {
      return null;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  /** 服務自己的 known_hosts 記下的主機指紋（首次 SSH 連接時記下）。 */
  async hostKeys() {
    if (!fs.existsSync(this.knownHostsFile) || !which('ssh-keygen')) return [];
    try {
      return (await keygen(['-l', '-f', this.knownHostsFile])).split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async info() {
    const publicKey = await this.publicKey();
    const meta = this.fromEnv ? {} : this.readMeta();
    return {
      available: this.available(),
      hasKey: !!publicKey,
      source: !publicKey ? null : this.fromEnv ? 'env' : meta.source || 'generated',
      keyFile: this.fromEnv ? this.keyFile : undefined,
      publicKey,
      fingerprint: await this.fingerprint(publicKey),
      createdAt: meta.createdAt || null,
      hostKeys: await this.hostKeys()
    };
  }

  /** 產生新的 ed25519 部署金鑰，替換舊的；返回公鑰。 */
  async generate({ comment = 'knowledge-setup-deploy-key' } = {}) {
    this.requireWritable();
    this.requireTools();
    this.ensureDir();
    const tmp = path.join(this.dir, `.deploy_key.${process.pid}.${Date.now()}`);
    try {
      await keygen(['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', tmp]);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.keyFile);
      fs.renameSync(`${tmp}.pub`, `${this.keyFile}.pub`);
    } catch (err) {
      throw httpError(500, `無法產生部署金鑰：${err.message}`, 'ssh_keygen_failed');
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}.pub`, { force: true });
    }
    this.writeMeta({ source: 'generated', createdAt: new Date().toISOString() });
    return this.publicKey();
  }

  /** 使用貼上的私鑰（OpenSSH / PEM 格式，不能有密碼保護）；返回公鑰。 */
  async import(text) {
    this.requireWritable();
    this.requireTools();
    const body = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!body) throw httpError(400, '請貼上私鑰', 'invalid_input');
    if (/^(ssh-|ecdsa-|sk-)/.test(body)) throw httpError(400, '這是公鑰；請貼上私鑰（以 -----BEGIN … PRIVATE KEY----- 開頭）', 'ssh_key_invalid');
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body)) throw httpError(400, '無法識別的私鑰格式：請貼上以 -----BEGIN … PRIVATE KEY----- 開頭的完整私鑰', 'ssh_key_invalid');
    this.ensureDir();
    const tmp = path.join(this.dir, `.import_key.${process.pid}.${Date.now()}`);
    try {
      fs.writeFileSync(tmp, body + '\n', { mode: 0o600 });
      let pub;
      try {
        pub = (await keygen(['-y', '-f', tmp])).trim();
      } catch {
        throw httpError(400, '私鑰無效或有密碼保護；請使用沒有密碼的私鑰，或在後台直接產生部署金鑰', 'ssh_key_invalid');
      }
      fs.renameSync(tmp, this.keyFile);
      fs.writeFileSync(`${this.keyFile}.pub`, pub + '\n', { mode: 0o644 });
      this.writeMeta({ source: 'imported', createdAt: new Date().toISOString() });
      return pub;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async remove() {
    this.requireWritable();
    for (const f of [this.keyFile, `${this.keyFile}.pub`, this.metaFile]) fs.rmSync(f, { force: true });
  }

  /** 清除記下的主機指紋（主機確實更換了金鑰時使用；下次連接重新記錄）。 */
  async clearHostKeys() {
    fs.rmSync(this.knownHostsFile, { force: true });
  }
}
