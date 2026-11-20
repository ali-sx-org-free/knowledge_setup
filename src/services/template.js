// 管道請求的模板替換（http、mock、rpa 管道共用）。
import crypto from 'node:crypto';

export function getPath(obj, dotted) {
  if (!dotted) return obj;
  return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function seededInt(seed, min, max) {
  const h = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return min + (h % (max - min + 1));
}

/** 模板替換：{input.sku}、{object.locator}、{item.structured.value}、{query.x}、{params.x}、{rand:0:500}、${env:NAME} */
export function renderTemplate(value, ctx, env = process.env) {
  if (typeof value === 'string') {
    const whole = /^\{rand:(-?\d+):(-?\d+)\}$/.exec(value);
    if (whole) return seededInt(JSON.stringify(ctx.seed || ''), Number(whole[1]), Number(whole[2]));
    return value
      .replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, n) => env[n] ?? '')
      .replace(/\{rand:(-?\d+):(-?\d+)\}/g, (_, a, b) => String(seededInt(JSON.stringify(ctx.seed || ''), Number(a), Number(b))))
      .replace(/\{([a-zA-Z_][\w.]*)\}/g, (m, p) => {
        const v = getPath(ctx, p);
        return v === undefined || v === null ? '' : String(v);
      });
  }
  if (Array.isArray(value)) return value.map(v => renderTemplate(v, ctx, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplate(v, ctx, env)]));
  return value;
}
