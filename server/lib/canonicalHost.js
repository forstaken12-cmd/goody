'use strict';

/**
 * Send people on other hosts (goody-dfi5.onrender.com, www.goody.day) to the
 * one real address in PUBLIC_BASE_URL with a 301.
 *
 * Only for GET/HEAD page loads. Partner postbacks (/postback/*), the health
 * check, and any POST/PUT/etc. are left alone so old URLs keep working.
 * Off unless PUBLIC_BASE_URL is https and not localhost, so local runs and
 * tests are untouched. Set CANONICAL_REDIRECT=0 to turn it off.
 */

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i;

function canonicalTarget(publicBaseUrl) {
  let u;
  try { u = new URL(String(publicBaseUrl || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (LOCAL_HOST.test(u.hostname)) return null;
  return { origin: u.origin, host: u.host.toLowerCase() };
}

function requestHost(req) {
  const fwd = req.headers['x-forwarded-host'];
  const raw = (fwd ? String(fwd).split(',')[0] : req.headers.host) || '';
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

function hostnameOnly(host) {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.replace(/:\d+$/, '');
}

function isExempt(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  const p = req.path || '/';
  return p === '/api/health' || p === '/postback' || p.startsWith('/postback/');
}

function canonicalHostMiddleware(cfg) {
  const target = cfg && cfg.canonicalRedirect !== false ? canonicalTarget(cfg.publicBaseUrl) : null;
  return function canonicalHost(req, res, next) {
    if (!target || isExempt(req)) return next();
    const host = requestHost(req);
    if (!host || host === target.host) return next();
    const name = hostnameOnly(host);
    // Never bounce local or raw-IP requests (local runs, internal probes).
    if (LOCAL_HOST.test(name) || IP_HOST.test(name)) return next();
    res.redirect(301, target.origin + (req.originalUrl || req.url || '/'));
  };
}

module.exports = { canonicalHostMiddleware, canonicalTarget, requestHost };
