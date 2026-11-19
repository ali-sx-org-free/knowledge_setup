// 命令列查看 / 產生 SSH 部署金鑰，與後台「設定 › 知識倉庫 › SSH 部署金鑰」是同一把（DATA_DIR/ssh/）。
// 以環境變數 KNOWLEDGE_GIT_URL 配置 SSH 倉庫時，先用它取得公鑰並添加到倉庫的 Deploy keys，再啟動服務：
//   npm run ssh-key              顯示公鑰（還沒有時產生）
//   npm run ssh-key -- --rotate  重新產生（舊公鑰失效）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SshKeys } from '../src/git/ssh.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
const keys = new SshKeys({ dir: path.join(dataDir, 'ssh'), keyFile: process.env.KNOWLEDGE_GIT_SSH_KEY_FILE });

try {
  if (process.argv.includes('--rotate') || !keys.hasKey()) await keys.generate();
  const info = await keys.info();
  console.log(info.publicKey);
  console.error(`\n指紋：${info.fingerprint}\n私鑰：${keys.keyFile}（只存本地，不進入知識倉庫）`);
  console.error('把上面的公鑰添加到倉庫 Settings › Deploy keys，並勾選 Allow write access。');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
