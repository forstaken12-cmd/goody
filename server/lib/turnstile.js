'use strict';

/**
 * Cloudflare Turnstile server-side verification.
 * Off unless both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set.
 * Never logs the secret key or the token.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 8000;
const CHECK_MESSAGE = 'Please finish the quick check.';

function turnstileEnabled(cfg) {
  return !!(cfg && String(cfg.turnstileSiteKey || '').trim() && String(cfg.turnstileSecretKey || '').trim());
}

function tokenFrom(req) {
  const body = (req && req.body) || {};
  const q = (req && req.query) || {};
  const t = body.turnstileToken || body['cf-turnstile-response'] || q.turnstileToken || q.cfToken || '';
  return String(t || '').trim();
}

async function verifyTurnstile(cfg, token, { remoteip, fetchFn, timeoutMs } = {}) {
  if (!turnstileEnabled(cfg)) return { ok: true, skipped: true };
  const t = String(token || '').trim();
  if (!t) return { ok: false, codes: ['missing-input-response'] };
  if (t.length > 2048) return { ok: false, codes: ['invalid-input-response'] };
  const body = new URLSearchParams({ secret: cfg.turnstileSecretKey, response: t });
  if (remoteip) body.set('remoteip', String(remoteip));
  const doFetch = fetchFn || fetch;
  try {
    const res = await doFetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs || TURNSTILE_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.success === true) return { ok: true };
    const codes = Array.isArray(data && data['error-codes']) ? data['error-codes'] : [];
    return { ok: false, codes: codes.length ? codes : ['http-' + res.status] };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, codes: [timedOut ? 'siteverify-timeout' : 'siteverify-unreachable'] };
  }
}

module.exports = {
  SITEVERIFY_URL,
  TURNSTILE_TIMEOUT_MS,
  CHECK_MESSAGE,
  turnstileEnabled,
  tokenFrom,
  verifyTurnstile
};
