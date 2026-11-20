// SSH 部署金鑰：金鑰管理、地址識別、錯誤提示，以及經本機 sshd 的端到端（產生金鑰 → 測試連接 → 克隆空倉庫 → 推送 → 回拉 → 主機指紋）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { SshKeys, isSshUrl, githubDeployKeyUrl } from '../src/git/ssh.js';
import { explainSshError } from '../src/git/repo.js';
import { startServer, tmpDir } from './helpers.js';

const has = cmd => {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const SSH_TOOLS = has('ssh') && has('ssh-keygen');
const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/usr/bin/sshd'].find(p => { try { execFileSync('test', ['-x', p]); return true; } catch { return false; } });

test('識別 SSH 地址與 GitHub Deploy keys 頁面', () => {
  for (const u of ['git@github.com:ali-sx-org-free/knowledge_site_v01.git', 'ssh://git@github.com/org/repo.git', 'ssh://git@ssh.github.com:443/org/repo.git', 'git+ssh://git@example.com/x.git', 'deploy@10.0.0.5:/srv/git/k.git']) assert.equal(isSshUrl(u), true, u);
  for (const u of ['', 'https://github.com/org/repo.git', 'file:///tmp/x.git', '/tmp/x.git', 'http://user@host:8080/x.git']) assert.equal(isSshUrl(u), false, u);
  assert.equal(githubDeployKeyUrl('git@github.com:ali-sx-org-free/knowledge_site_v01.git'), 'https://github.com/ali-sx-org-free/knowledge_site_v01/settings/keys/new');
  assert.equal(githubDeployKeyUrl('ssh://git@ssh.github.com:443/org/repo.git'), 'https://github.com/org/repo/settings/keys/new');
  assert.equal(githubDeployKeyUrl('git@gitlab.com:org/repo.git'), null);
});

test('SSH 失敗補上處理提示', () => {
  assert.match(explainSshError('git@github.com: Permission denied (publickey).'), /Deploy keys/);
  assert.match(explainSshError('ERROR: The key you are authenticating with has been marked as read only.'), /Allow write access/);
  assert.match(explainSshError('Host key verification failed.'), /清除主機指紋/);
  assert.match(explainSshError('ssh: connect to host github.com port 22: Connection refused'), /ssh\.github\.com:443/);
  assert.match(explainSshError('error: cannot run ssh: No such file or directory'), /安裝 OpenSSH/);
  assert.match(explainSshError('sh: 1: ssh: not found'), /安裝 OpenSSH/);
  const notFound = explainSshError('git ls-remote -- ssh://git@github.com/org/x.git 失敗：ERROR: Repository not found.');
  assert.match(notFound, /部署金鑰只能訪問/);
  assert.doesNotMatch(notFound, /安裝 OpenSSH/);
  assert.equal(explainSshError('其他錯誤'), '其他錯誤');
});

test('部署金鑰：產生、貼上私鑰、拒絕公鑰與有密碼的私鑰、刪除', { skip: !SSH_TOOLS && '沒有 OpenSSH 客戶端' }, async () => {
  const dir = await tmpDir();
  const keys = new SshKeys({ dir: path.join(dir, 'ssh') });
  assert.equal((await keys.info()).hasKey, false);
  assert.equal(keys.sshCommand(), null);

  const pub = await keys.generate();
  assert.match(pub, /^ssh-ed25519 /);
  const info = await keys.info();
  assert.equal(info.source, 'generated');
  assert.match(info.fingerprint, /SHA256:/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(keys.keyFile)).mode & 0o777, 0o600);
  assert.match(keys.sshCommand(), /IdentitiesOnly=yes/);
  assert.match(keys.sshCommand(), /StrictHostKeyChecking=accept-new/);

  // 貼上既有私鑰（例如已在別處登記過的部署金鑰）
  const ext = path.join(dir, 'external');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'external', '-f', ext]);
  const imported = await keys.import((await fs.readFile(ext, 'utf8')).replace(/\n/g, '\r\n'));
  assert.equal(imported.split(' ').slice(0, 2).join(' '), (await fs.readFile(`${ext}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' '));
  assert.equal((await keys.info()).source, 'imported');

  await assert.rejects(keys.import(await fs.readFile(`${ext}.pub`, 'utf8')), /這是公鑰/);
  await assert.rejects(keys.import('not a key'), /無法識別/);
  const locked = path.join(dir, 'locked');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'secret-pass', '-f', locked]);
  await assert.rejects(keys.import(await fs.readFile(locked, 'utf8')), /密碼保護/);
  assert.equal((await keys.info()).source, 'imported', '失敗的貼上不影響現有金鑰');

  await keys.remove();
  assert.equal((await keys.info()).hasKey, false);

  const fromEnv = new SshKeys({ dir: path.join(dir, 'ssh2'), keyFile: ext });
  const envInfo = await fromEnv.info();
  assert.equal(envInfo.source, 'env');
  assert.match(envInfo.publicKey, /^ssh-ed25519 /);
  await assert.rejects(fromEnv.generate(), err => err.status === 409);
});

// ---- 端到端：本機 sshd 扮演 GitHub（部署金鑰 = authorized_keys 中的一行）

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise(resolve => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function startSshd(root, port) {
  const user = os.userInfo().username;
  const hostKey = path.join(root, 'host_ed25519');
  await fs.rm(hostKey, { force: true });
  await fs.rm(`${hostKey}.pub`, { force: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  const config = path.join(root, 'sshd_config');
  await fs.writeFile(config, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${path.join(root, 'sshd.pid')}`,
    `AuthorizedKeysFile ${path.join(root, 'authorized_keys')}`, 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes', 'PermitRootLogin prohibit-password', `AllowUsers ${user}`, 'LogLevel ERROR', ''
  ].join('\n'));
  if (process.getuid?.() === 0) await fs.mkdir('/run/sshd', { recursive: true, mode: 0o755 }).catch(() => {});
  const proc = spawn(SSHD, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => (stderr += d));
  const up = await waitForPort(port);
  if (!up) {
    proc.kill();
    throw new Error(`sshd 未能啟動：${stderr}`);
  }
  return { proc, user, stop: () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(); }) };
}

test('SSH 部署金鑰端到端：未授權時提示 → 授權後克隆空倉庫、推送、回拉 → 不受 insteadOf 改寫 → 主機指紋變更被拒', { skip: (!SSH_TOOLS || !SSHD) && '沒有 sshd / OpenSSH', timeout: 120000 }, async t => {
  const root = await tmpDir('kb-ssh-');
  const port = await freePort();
  let sshd;
  try {
    sshd = await startSshd(root, port);
  } catch (err) {
    t.skip(err.message);
    return;
  }
  // 空倉庫，和 knowledge_site_v01 一樣還沒有任何提交
  const bare = path.join(root, 'knowledge_site_v01.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const url = `ssh://${sshd.user}@127.0.0.1:${port}${bare}`;
  const s = await startServer();
  try {
    // 1. 產生部署金鑰（只返回公鑰）
    const gen = await s.admin('POST', '/admin/api/settings/git/ssh-key');
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    const pub = gen.body.data.publicKey;
    assert.match(pub, /^ssh-ed25519 /);
    assert.equal(JSON.stringify(gen.body).includes('PRIVATE KEY'), false, '接口不返回私鑰');

    // 2. 公鑰尚未添加到倉庫：測試連接失敗並提示 Deploy keys
    const denied = await s.admin('POST', '/admin/api/settings/git/test', { url, branch: 'main' });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error.message, /Permission denied/);
    assert.match(denied.body.error.message, /Deploy keys/);

    // 3. 「添加 Deploy key」：寫入 authorized_keys
    await fs.writeFile(path.join(root, 'authorized_keys'), pub + '\n');
    const ok = await s.admin('POST', '/admin/api/settings/git/test', { url, branch: 'main' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.auth, 'ssh-deploy-key');
    assert.equal(ok.body.data.empty, true);
    const info = (await s.admin('GET', '/admin/api/settings')).body.data.ssh;
    assert.equal(info.hostKeys.length, 1, '首次連接記下主機指紋');
    assert.match(info.hostKeys[0], /SHA256:.*\[127\.0\.0\.1\]/);

    // 4. 保存並切換：經 SSH 克隆空倉庫；寫入後推送
    const saved = await s.admin('PUT', '/admin/api/settings/git', { url, branch: 'main', subdir: 'knowledge' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.status.auth, 'ssh-deploy-key');
    const agent = await s.keyFor('agent', 'contributor', 'SSH 測試');
    const r = await agent('POST', '/api/v1/subjects', { name: '倉儲管理系統', type: '系統', domain: 'WMS', definition: '入庫、上架、揀貨與出庫' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await s.srv.ctx.store.flushPush();
    assert.equal(s.srv.ctx.store.repo.status.lastError, null);
    const files = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(files, new RegExp(`knowledge/subjects/${r.body.data.id}\\.yaml`));

    // 5. 他人直接在倉庫中修改，經 SSH 拉取回來
    const work = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', bare, work]);
    const file = path.join(work, 'knowledge', 'subjects', `${r.body.data.id}.yaml`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('入庫、上架、揀貨與出庫', '入庫、上架、揀貨、出庫與盤點'));
    execFileSync('git', ['-C', work, '-c', 'user.name=Reviewer', '-c', 'user.email=r@example.com', 'commit', '-qam', '人工補充定義']);
    execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main']);
    const sync = await s.admin('POST', '/admin/api/sync');
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.data.changed, true);
    assert.equal((await agent('GET', `/api/v1/subjects/${r.body.data.id}`)).body.data.subject.definition, '入庫、上架、揀貨、出庫與盤點');

    // 6. 環境中注入的 url.insteadOf（例如把 ssh 地址改寫成 https）不影響部署金鑰連接
    const saved_env = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file:///nonexistent/hijack.git.insteadOf', GIT_CONFIG_VALUE_0: url });
    try {
      const again = await s.admin('POST', '/admin/api/settings/git/test', { url, branch: 'main' });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.data.branchExists, true);
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (k in saved_env) process.env[k] = saved_env[k];
        else delete process.env[k];
      }
    }

    // 7. 遠端主機更換金鑰：拒絕連接並提示；清除主機指紋後重新記下
    await sshd.stop();
    sshd = await startSshd(root, port);
    const changed = await s.admin('POST', '/admin/api/settings/git/test', { url, branch: 'main' });
    assert.equal(changed.status, 400);
    assert.match(changed.body.error.message, /清除主機指紋/);
    assert.equal((await s.admin('DELETE', '/admin/api/settings/git/known-hosts')).status, 200);
    assert.equal((await s.admin('POST', '/admin/api/settings/git/test', { url, branch: 'main' })).status, 200);

    // 8. 刪除金鑰後回到本機 ssh 設定，認證方式顯示隨之改變
    assert.equal((await s.admin('DELETE', '/admin/api/settings/git/ssh-key')).body.data.hasKey, false);
    assert.equal((await s.admin('GET', '/admin/api/settings')).body.data.gitStatus.auth, 'ssh-system');
  } finally {
    await s.close();
    await sshd?.stop();
  }
});

test('貼上私鑰的接口：錯誤格式返回 400，不覆蓋現有金鑰', { skip: !SSH_TOOLS && '沒有 OpenSSH 客戶端' }, async () => {
  const s = await startServer();
  try {
    const gen = await s.admin('POST', '/admin/api/settings/git/ssh-key');
    const bad = await s.admin('POST', '/admin/api/settings/git/ssh-key', { privateKey: gen.body.data.publicKey });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'ssh_key_invalid');
    assert.equal((await s.admin('GET', '/admin/api/settings/git/ssh-key')).body.data.publicKey, gen.body.data.publicKey);
    const agent = await s.keyFor('agent', 'contributor');
    assert.equal((await agent('POST', '/admin/api/settings/git/ssh-key')).status, 403, '智能體不能管理部署金鑰');
  } finally {
    await s.close();
  }
});
