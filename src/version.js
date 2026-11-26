// 服務版本：取 package.json（發佈流水綫要求標籤與它一致），/status 與 OpenAPI 共用。
import fs from 'node:fs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
