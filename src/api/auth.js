// 身份與權限：API 金鑰（三方智能體 / 人 / 管道）與後台會話。
import crypto from 'node:crypto';
import { tr } from '../i18n/index.js';
import { API_KEY_SCOPES, SCOPE_CONFIRM_ASSERTIONS, hasScope } from '../store/model.js';

export const ROLE_ORDER = { consumer: 0, contributor: 1, owner: 2 };
const SESSION_TTL_MS = 12 * 3600 * 1000;
const COOKIE = 'kb_session';

export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const ADMIN_PRINCIPAL = Object.freeze({ id: 'admin', name: '管理員', kind: 'human', role: 'owner', isAdmin: true });

function principalFromKey(k) {
  // scopes：管理員單獨授予的附加權限（見 model.js 的 API_KEY_SCOPES）；管道金鑰不帶附加權限。
  const scopes = k.kind === 'pipeline' ? [] : (Array.isArray(k.scopes) ? k.scopes : []).filter(x => API_KEY_SCOPES.includes(x));
  return { id: k.id, name: k.name, kind: k.kind, role: k.kind === 'pipeline' ? 'contributor' : k.role, isAdmin: false, scopes };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map();
  }

  login({ password, apiKey }) {
    let principal = null;
    if (password && this.ctx.settings.checkAdminPassword(password)) principal = ADMIN_PRINCIPAL;
    else if (apiKey) {
      const k = this.ctx.settings.findApiKey(apiKey);
      if (k && k.kind === 'human') principal = principalFromKey(k);
      else if (k) throw new HttpError(403, tr('後台只允許人登入；智能體請直接使用 API'), 'forbidden');
    }
    if (!principal) throw new HttpError(401, tr('密碼或金鑰不正確'), 'unauthorized');
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { principal, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, principal };
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.sessions.delete(token);
  }

  cookieFor(token, req) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  /** 解析請求身份；不拋錯，沒有身份時返回 null。 */
  identify(req) {
    const header = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1] || req.headers['x-api-key'];
    if (bearer) {
      const k = this.ctx.settings.findApiKey(String(bearer).trim());
      if (!k) throw new HttpError(401, tr('API 金鑰無效或已停用'), 'unauthorized');
      this.ctx.settings.touchApiKey(k.id);
      return { principal: principalFromKey(k), via: 'api_key' };
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const s = this.sessions.get(token);
      if (s && s.expiresAt > Date.now()) {
        s.expiresAt = Date.now() + SESSION_TTL_MS;
        return { principal: s.principal, via: 'session' };
      }
      this.sessions.delete(token);
    }
    return null;
  }

  middleware() {
    return (req, res, next) => {
      try {
        const id = this.identify(req);
        req.principal = id?.principal || null;
        req.authVia = id?.via || null;
        // 會話（瀏覽器）發起的寫請求：校驗 Origin，防跨站請求。
        if (id?.via === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, tr('跨站請求被拒絕'), 'csrf');
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    const p = req.principal;
    if (!p) return next(new HttpError(401, tr('需要身份驗證：請帶 Authorization: Bearer <API 金鑰>'), 'unauthorized'));
    if (p.isAdmin) return next();
    const effective = p.kind === 'pipeline' ? 'contributor' : p.role;
    if ((ROLE_ORDER[effective] ?? -1) < ROLE_ORDER[role]) return next(new HttpError(403, tr('此操作需要 {role} 權限', { role }), 'forbidden'));
    next();
  };
}

/**
 * 確認端點的入口：負責人角色，或持 assertions:confirm 權限的金鑰。這裡只放行；
 * 能確認哪些條目（金鑰只限斷言、指定負責人、層級與審閱版本）由 store.confirmMode / assertReviewed 逐條判斷。
 */
export function requireConfirm(req, res, next) {
  const p = req.principal;
  if (!p) return next(new HttpError(401, tr('需要身份驗證：請帶 Authorization: Bearer <API 金鑰>'), 'unauthorized'));
  if (p.isAdmin || (p.kind !== 'pipeline' && p.role === 'owner') || (p.kind !== 'pipeline' && hasScope(p, SCOPE_CONFIRM_ASSERTIONS))) return next();
  next(new HttpError(403, tr('此操作需要 owner 權限，或金鑰權限 {scope}（只能確認斷言）', { scope: SCOPE_CONFIRM_ASSERTIONS }), 'forbidden'));
}

export function requireAdmin(req, res, next) {
  if (!req.principal) return next(new HttpError(401, tr('需要登入'), 'unauthorized'));
  if (!req.principal.isAdmin) return next(new HttpError(403, tr('需要管理員權限'), 'forbidden'));
  next();
}
