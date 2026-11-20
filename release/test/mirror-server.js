// 安裝腳本測試用的模擬下載來源：以 GitHub Releases 的路徑格式提供 dist/ 下的檔案。
//   node release/test/mirror-server.js --dir dist --port 9001 [--throttle 65536] [--corrupt]
// 同時支持直連形式 /<owner>/<repo>/releases/download/<tag>/<file> 與代理形式 /https://github.com/<owner>/<repo>/...；
// /releases/latest/download/<file> 視為最新版本。支持 Range（測速只取前幾百 KB）。
//   --throttle N  限速 N 字節/秒（模擬慢鏡像）
//   --corrupt     發佈包內容被篡改（SHA256SUMS 正常），用來驗證安裝腳本的校驗與回退
// 啟動後在標準輸出打印一行 "listening <port>"；給了 --port-file 時另把端口寫入該檔（Windows 上讀被重定向中的輸出檔可能被鎖）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const dir = path.resolve(opt('dir') || 'dist');
const port = Number(opt('port') || 0);
const throttle = Number(opt('throttle') || 0);
const corrupt = !!opt('corrupt');
const portFile = opt('port-file');

const ROUTE = /^\/(?:https?:\/\/github\.com\/)?[^/]+\/[^/]+\/releases\/(?:latest\/download|download\/[^/]+)\/([^/]+)$/;

function send(res, buf, start, end, status) {
  const chunk = buf.subarray(start, end + 1);
  res.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': chunk.length,
    'accept-ranges': 'bytes',
    ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${buf.length}` } : {})
  });
  if (!throttle) return res.end(chunk);
  // 每 50ms 送出 throttle/20 字節
  const step = Math.max(1, Math.floor(throttle / 20));
  let off = 0;
  const timer = setInterval(() => {
    if (res.destroyed) return clearInterval(timer);
    const part = chunk.subarray(off, off + step);
    off += part.length;
    if (off >= chunk.length) {
      clearInterval(timer);
      res.end(part);
    } else {
      res.write(part);
    }
  }, 50);
  res.on('close', () => clearInterval(timer));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/https?:\/(?!\/)/, m => `${m}/`);
  const m = ROUTE.exec(url);
  const file = m && path.join(dir, path.basename(m[1]));
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not Found');
  }
  let buf = fs.readFileSync(file);
  if (corrupt && /\.(tar\.gz|zip)$/.test(file)) {
    buf = Buffer.from(buf);
    for (let i = 1024; i < buf.length; i += 4096) buf[i] ^= 0xff;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : buf.length - 1, buf.length - 1);
    if (start >= buf.length) {
      res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
      return res.end();
    }
    return send(res, buf, start, end, 206);
  }
  return send(res, buf, 0, buf.length - 1, 200);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  if (typeof portFile === 'string') {
    fs.writeFileSync(`${portFile}.tmp`, String(actual));
    fs.renameSync(`${portFile}.tmp`, portFile);
  }
  console.log(`listening ${actual}`);
});
