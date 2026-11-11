'use strict';

const crypto = require('crypto');

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hmac(algo, secret, data, enc) {
  return crypto.createHmac(algo, secret).update(data).digest(enc || 'hex');
}

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function first(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function buildFullUrl(req, publicBaseUrl) {
  if (publicBaseUrl) {
    const base = publicBaseUrl.replace(/\/$/, '');
    return base + req.originalUrl;
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || 'localhost').split(',')[0].trim();
  return proto + '://' + host + req.originalUrl;
}

function urlWithoutParam(url, param) {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const base = url.slice(0, i);
  const sp = new URLSearchParams(url.slice(i + 1));
  sp.delete(param);
  const q = sp.toString();
  return q ? base + '?' + q : base;
}

/**
 * BitLabs: HMAC-SHA1 of the complete URL excluding &hash=... (public docs).
 * Must hash the URL as received, without re-encoding.
 */
function verifyBitlabs(req, secret, publicBaseUrl) {
  const url = buildFullUrl(req, publicBaseUrl);
  const idx = url.lastIndexOf('&hash=');
  if (idx < 0) return { ok: false, reason: 'missing hash' };
  const without = url.slice(0, idx);
  const got = url.slice(idx + 6);
  const expect = hmac('sha1', secret, without, 'hex');
  return { ok: timingSafeEqual(expect, got), reason: timingSafeEqual(expect, got) ? 'ok' : 'bad hash' };
}

/** AdGem v3: HMAC-SHA256 of raw body vs Signature header. v2: HMAC-SHA256 of URL without verifier. */
function verifyAdgem(req, secret, publicBaseUrl) {
  const header = req.get && (req.get('Signature') || req.get('signature'));
  if (header && req.rawBody) {
    const expect = hmac('sha256', secret, req.rawBody, 'hex');
    const ok = timingSafeEqual(expect, header);
    return { ok, reason: ok ? 'ok' : 'bad signature' };
  }
  const url = buildFullUrl(req, publicBaseUrl);
  if (url.includes('verifier=')) {
    const without = urlWithoutParam(url, 'verifier');
    const got = (req.query && req.query.verifier) || '';
    const expect = hmac('sha256', secret, without, 'hex');
    const ok = timingSafeEqual(expect, got);
    return { ok, reason: ok ? 'ok' : 'bad verifier' };
  }
  return { ok: false, reason: 'missing signature' };
}

/** CPX Research (publisher examples): md5(trans_id + "-" + app secure hash). */
function verifyCpx(body, secret) {
  const transId = first(body, ['trans_id', 'transid', 'transaction_id']);
  const got = first(body, ['secure_hash', 'hash']);
  if (!transId || !got) return { ok: false, reason: 'missing hash or trans_id' };
  const expect = md5(String(transId) + '-' + secret);
  const ok = timingSafeEqual(expect, got);
  return { ok, reason: ok ? 'ok' : 'bad hash' };
}

/**
 * Generic demo / placeholder: HMAC-SHA256 of "uid|txid|payout|status"
 * in header x-goody-signature or query/body sig / hash.
 */
function verifyGeneric(body, secret) {
  const uid = first(body, ['uid', 'user_id', 'userid', 'player_id']);
  const txid = first(body, ['txid', 'tx_id', 'tx', 'transaction_id', 'trans_id']);
  const payout = first(body, ['payout', 'amount_usd', 'usd', 'raw', 'partner_usd']);
  const status = first(body, ['status', 'state', 'type']) || '';
  const got = first(body, ['sig', 'hash', 'signature', 'secure_hash']);
  if (!got) return { ok: false, reason: 'missing signature' };
  const payload = [uid, txid, payout, status].map((x) => (x == null ? '' : String(x))).join('|');
  const expect = hmac('sha256', secret, payload, 'hex');
  const ok = timingSafeEqual(expect, got);
  return { ok, reason: ok ? 'ok' : 'bad signature' };
}


/** Lootably (public docs): sha256(userID + ip + revenue + currencyReward + postback secret). */
function verifyLootably(body, secret) {
  const userID = first(body, ['userID', 'userid', 'user_id', 'uid']) || '';
  const ip = first(body, ['ip', 'userIP', 'user_ip']) || '';
  const revenue = first(body, ['revenue']) != null ? String(first(body, ['revenue'])) : '';
  const currencyReward = first(body, ['currencyReward', 'reward']) != null ? String(first(body, ['currencyReward', 'reward'])) : '';
  const got = first(body, ['hash']);
  if (!got) return { ok: false, reason: 'missing hash' };
  const expect = crypto.createHash('sha256').update(String(userID) + String(ip) + revenue + currencyReward + secret).digest('hex');
  const ok = timingSafeEqual(expect, got);
  return { ok, reason: ok ? 'ok' : 'bad hash' };
}

/** Torox (publisher integration guide): md5(oid + "-" + user_id + "-" + app placement key). */
function verifyTorox(body, secret) {
  const oid = first(body, ['oid', 'offer_id']);
  const userId = first(body, ['user_id', 'userId', 'uid']);
  const got = first(body, ['sig', 'hash']);
  if (oid == null || userId == null || !got) return { ok: false, reason: 'missing sig, oid, or user_id' };
  const expect = md5(String(oid) + '-' + String(userId) + '-' + secret);
  const ok = timingSafeEqual(expect, got);
  return { ok, reason: ok ? 'ok' : 'bad signature' };
}

function signGeneric({ uid, txid, payout, status }, secret) {
  const payload = [uid, txid, payout, status].map((x) => (x == null ? '' : String(x))).join('|');
  return hmac('sha256', secret, payload, 'hex');
}

function parseStatus(style, body) {
  const raw = String(first(body, ['status', 'state', 'type', 'offer_state']) || 'paid').toLowerCase();
  if (style === 'cpx') {
    if (String(body.status) === '2' || raw === '2') return 'reversal';
    return 'paid';
  }
  if (style === 'bitlabs') {
    if (raw === 'reconciliation' || raw === 'reversal' || raw === 'chargeback') return 'reversal';
    if (raw === 'pending' || raw === 'hold') return 'pending';
    // SCREENOUT is a paid (usually smaller) completion, not a reversal
    return 'paid';
  }
  if (style === 'lootably') {
    if (String(body.status) === '0' || raw === '0') return 'reversal';
    return 'paid';
  }
  if (style === 'torox' || style === 'ayet') {
    const payout = Number(first(body, ['payout', 'payout_usd', 'amount', 'revenue']));
    if (String(body.is_chargeback) === '1' || raw === 'chargeback' || (Number.isFinite(payout) && payout < 0)) return 'reversal';
  }
  if (raw === '0' || raw === 'rejected' || raw === 'reversal' || raw === 'chargeback' || raw === 'canceled' || raw === 'cancelled') {
    return 'reversal';
  }
  if (raw === 'pending' || raw === 'checking' || raw === 'hold') return 'pending';
  return 'paid';
}

function parseFields(style, body) {
  const uid = first(body, ['uid', 'user_id', 'userid', 'userID', 'player_id', 'external_identifier', 'USER:ID', 'USER:UID']);
  const txid = first(body, ['txid', 'tx_id', 'tx', 'transaction_id', 'transactionID', 'trans_id', 'conversion_id', 'id', 'TX', 'request_id']);
  const payout = Number(first(body, ['payout', 'payout_usd', 'amount_usd', 'usd', 'raw', 'partner_usd', 'VALUE:USD', 'revenue']));
  const offerId = first(body, ['offer_id', 'offerid', 'offerID', 'offer_ID', 'oid', 'campaign_id', 'task_id']);
  const sourceHint = first(body, ['source', 'kind']);
  return {
    uid: uid != null ? String(uid) : undefined,
    txid: txid != null ? String(txid) : undefined,
    partnerUsd: Number.isFinite(payout) ? payout : 0,
    offerId: offerId != null ? String(offerId) : undefined,
    sourceHint: sourceHint != null ? String(sourceHint) : undefined,
    status: parseStatus(style, body)
  };
}

function flattenAdgem(req) {
  const body = Object.assign({}, req.query || {}, req.body || {});
  if (req.body && req.body.data && typeof req.body.data === 'object') {
    Object.assign(body, req.body.data);
    if (req.body.request_id && !body.transaction_id) body.transaction_id = req.body.request_id;
  }
  return body;
}

function verifyAndParse(req, partnerCfg, publicBaseUrl) {
  const style = partnerCfg.style || 'generic';
  const secret = partnerCfg.secret;
  if (!secret) return { ok: false, reason: 'partner secret not configured', http: 503 };

  const body = style === 'adgem' ? flattenAdgem(req) : Object.assign({}, req.query || {}, req.body || {});
  let v;
  if (style === 'bitlabs') v = verifyBitlabs(req, secret, publicBaseUrl);
  else if (style === 'adgem') v = verifyAdgem(req, secret, publicBaseUrl);
  else if (style === 'cpx') v = verifyCpx(body, secret);
  else if (style === 'lootably') v = verifyLootably(body, secret);
  else if (style === 'torox') v = verifyTorox(body, secret);
  else v = verifyGeneric(body, secret);

  if (!v.ok) return { ok: false, reason: v.reason, http: 403 };
  const fields = parseFields(style, body);
  if (!fields.uid || !fields.txid) {
    return { ok: false, reason: 'missing user or transaction id', http: 400, fields };
  }
  return { ok: true, fields, body };
}

module.exports = {
  hmac, md5, timingSafeEqual, verifyAndParse, signGeneric, parseFields, parseStatus,
  verifyBitlabs, verifyAdgem, verifyCpx, verifyGeneric, verifyLootably, verifyTorox, buildFullUrl
};
