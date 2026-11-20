// 服務入口：經符號連結的路徑啟動也要真正啟動（一鍵安裝的目錄可能在符號連結下，如 macOS 的 /var → /private/var）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('經符號連結的路徑執行 src/server.js 也會啟動服務', { skip: process.platform === 'win32' && 'Windows 建立符號連結需要權限', timeout: 30000 }, async () => {
  const dir = await tmpDir();
  const link = path.join(dir, 'app-link');
  await fs.symlink(ROOT, link, 'dir');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(link, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), ADMIN_PASSWORD: 'symlink-test-pass' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => (output += d));
  child.stderr.on('data', d => (output += d));
  try {
    const started = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 20000);
      child.stdout.on('data', () => { if (output.includes('服務已啟動')) { clearTimeout(timer); resolve(true); } });
      child.once('exit', () => { clearTimeout(timer); resolve(false); });
    });
    assert.ok(started, `服務沒有啟動（輸出：${output || '無'}，退出碼：${child.exitCode}）`);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/prompt`);
    assert.equal(res.status, 200);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
