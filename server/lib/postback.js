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

/**
 * CPX Research postback: {secure_hash} = md5(trans_id + "-" + app security hash).
 * The publisher dashboard's postback macro is {secure_hash}; Goody accepts it as
 * hash= or secure_hash= in the URL.
 */
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

/** The raw query string as received (no re-encoding), without the leading "?". */
function rawQueryOf(req) {
  const u = String((req && req.originalUrl) || '');
  const i = u.indexOf('?');
  return i < 0 ? '' : u.slice(i + 1);
}

// PHP urlencode / http_build_query style: RFC 1738, space as "+", only A-Za-z0-9 - _ . left as is.
function phpUrlencode(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
}

/**
 * ayeT-Studios (docs: Callback Verification → HMAC Security Hash):
 * header X-Ayetstudios-Security-Hash = hex HMAC-SHA256(all request params sorted by key and
 * URL-encoded as a query string, publisher API key). Their PHP sample uses ksort + http_build_query,
 * their JS sample uses URLSearchParams; both encodings are accepted.
 */
function ayetSignedStrings(pairs) {
  const byKey = pairs.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const byLocale = pairs.slice().sort((a, b) => a[0].localeCompare(b[0]));
  const out = new Set();
  for (const list of [byKey, byLocale]) {
    out.add(list.map(([k, v]) => phpUrlencode(k) + '=' + phpUrlencode(v)).join('&'));
    out.add(new URLSearchParams(list).toString());
  }
  return [...out];
}
function verifyAyet(req, secret) {
  const got = String((req.get && req.get('X-Ayetstudios-Security-Hash')) || (req.headers && req.headers['x-ayetstudios-security-hash']) || '').trim().toLowerCase();
  if (!got) return { ok: false, reason: 'missing signature' };
  let pairs = [...new URLSearchParams(rawQueryOf(req)).entries()];
  if (!pairs.length && req.query) pairs = Object.entries(req.query).map(([k, v]) => [k, String(v)]);
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    for (const [k, v] of Object.entries(req.body)) if (v != null && typeof v !== 'object') pairs.push([k, String(v)]);
  }
  const ok = ayetSignedStrings(pairs).some((s) => timingSafeEqual(hmac('sha256', secret, s, 'hex'), got));
  return { ok, reason: ok ? 'ok' : 'bad signature' };
}
function signAyet(params, secret) {
  return hmac('sha256', secret, ayetSignedStrings(Object.entries(params).map(([k, v]) => [k, String(v)]))[0], 'hex');
}

/** URL-safe Base64 of raw HMAC-SHA1, "=" padding stripped (TheoremReach request signing). */
function theoremHash(secret, s) {
  return crypto.createHmac('sha1', secret).update(s).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * TheoremReach reward callback: hash = base64url(HMAC-SHA1(secret key, full callback URL up to "&hash=")).
 * TheoremReach documents this scheme for API requests, entry links and redirects ("redirects are
 * hashed in the same way as S2S reward callbacks"). We check the URL against each public base we
 * could have been reached on (PUBLIC_BASE_URL, the forwarded host, and https://host).
 */
function verifyTheoremreach(req, secret, publicBaseUrl, extraBases) {
  const path = String(req.originalUrl || '');
  const m = path.match(/[?&]hash=([^&]*)$/);
  if (!m) return { ok: false, reason: 'missing hash' };
  const got = decodeURIComponent(m[1]);
  const without = path.slice(0, m.index);
  const bases = new Set();
  for (const b of extraBases || []) if (b) bases.add(String(b).replace(/\/$/, ''));
  if (publicBaseUrl) bases.add(publicBaseUrl.replace(/\/$/, ''));
  const full = buildFullUrl(req, '');
  bases.add(full.slice(0, full.length - path.length));
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || (req.get && req.get('host'));
  if (host) { bases.add('https://' + String(host).split(',')[0].trim()); bases.add('http://' + String(host).split(',')[0].trim()); }
  for (const b of bases) {
    if (timingSafeEqual(theoremHash(secret, b + without), got)) return { ok: true, reason: 'ok' };
  }
  return { ok: false, reason: 'bad hash' };
}

/** RapidoReach S2S: txnHash = md5(transactionId + App Secret), offerHash = md5(transactionId + App Key). */
function verifyRapidoreach(body, secret, appKey) {
  const tx = first(body, ['transactionId', 'offerInvitationId']);
  const txnHash = String(first(body, ['txnHash']) || '').toLowerCase();
  if (!tx || !txnHash) return { ok: false, reason: 'missing txnHash or transactionId' };
  if (!timingSafeEqual(md5(String(tx) + secret), txnHash)) return { ok: false, reason: 'bad txnHash' };
  const offerHash = first(body, ['offerHash']);
  if (appKey && offerHash != null && !timingSafeEqual(md5(String(tx) + appKey), String(offerHash).toLowerCase())) {
    return { ok: false, reason: 'bad offerHash' };
  }
  return { ok: true, reason: 'ok' };
}

/** CPX survey wall link for one user: secure_hash = md5(ext_user_id + "-" + security hash). */
function cpxWallUrl({ appId, secret, extUserId, subid1, subid2 }) {
  const q = new URLSearchParams();
  q.set('app_id', String(appId));
  q.set('ext_user_id', String(extUserId));
  if (secret) q.set('secure_hash', md5(String(extUserId) + '-' + secret));
  if (subid1) q.set('subid_1', String(subid1));
  if (subid2) q.set('subid_2', String(subid2));
  return 'https://offers.cpx-research.com/index.php?' + q.toString();
}

/** ayeT web surveywall / offerwall link (docs: Web Surveywall, Web Offerwall). */
function ayetWallUrl({ kind, adSlot, extUserId }) {
  if (kind === 'offers') {
    return 'https://offerwall.ayet.io/offers?' + new URLSearchParams({ adSlot: String(adSlot), externalIdentifier: String(extUserId) }).toString();
  }
  return 'https://surveys.ayet.io/surveys?' + new URLSearchParams({ adSlot: String(adSlot), external_identifier: String(extUserId) }).toString();
}

/**
 * TheoremReach web survey wall (docs/web): respondent_entry/direct?api_key&user_id&transaction_id.
 * When a secret is given the link is signed the documented way (hash appended last).
 */
function theoremreachWallUrl({ apiKey, secret, userId, transactionId }) {
  const base = 'https://theoremreach.com/respondent_entry/direct?' + new URLSearchParams({
    api_key: String(apiKey), user_id: String(userId), transaction_id: String(transactionId)
  }).toString();
  return secret ? base + '&hash=' + theoremHash(secret, base) : base;
}

/** RapidoReach iframe: userId = internalUserId-appId-md5(internalUserId-appId-appKey). */
function rapidoreachUid({ userId, appId, appKey }) {
  return String(userId) + '-' + String(appId) + '-' + md5(String(userId) + '-' + String(appId) + '-' + String(appKey));
}
function rapidoreachWallUrl({ userId, appId, appKey }) {
  return 'https://www.rapidoreach.com/ofw/?userId=' + encodeURIComponent(rapidoreachUid({ userId, appId, appKey }));
}

function signGeneric({ uid, txid, payout, status }, secret) {
  const payload = [uid, txid, payout, status].map((x) => (x == null ? '' : String(x))).join('|');
  return hmac('sha256', secret, payload, 'hex');
}

function parseStatus(style, body) {
  const raw = String(first(body, ['status', 'state', 'type', 'offer_state']) || 'paid').toLowerCase();
  if (style === 'cpx') {
    // CPX: 1 = completed, 2 = canceled / chargeback. Anything else is not ours to guess.
    const st = String(body.status == null ? '' : body.status).trim();
    if (st === '1') return 'paid';
    if (st === '2') return 'reversal';
    return 'unknown';
  }
  if (style === 'ayet') {
    const usd = Number(first(body, ['payout_usd', 'payout']));
    const amt = Number(first(body, ['currency_amount', 'amount']));
    if (String(body.is_chargeback) === '1' || (Number.isFinite(usd) && usd < 0) || (Number.isFinite(amt) && amt < 0)) return 'reversal';
    return 'paid';
  }
  if (style === 'theoremreach') {
    if (String(body.debug).toLowerCase() === 'true') return 'ignore';
    const usd = Number(first(body, ['reward_amount_in_dollars', 'currency', 'usd', 'payout_usd']));
    if (String(body.reversal).toLowerCase() === 'true' || (Number.isFinite(usd) && usd < 0)) return 'reversal';
    return 'paid';
  }
  if (style === 'rapidoreach') {
    const st = String(first(body, ['status', 'cmd']) || '').trim().toUpperCase();
    if (st === 'R') return 'reversal';
    if (st === 'C') return 'paid';
    if (st === 'F' || st === 'P') {
      // Screenout / over quota: only a reward when RapidoReach actually pays something.
      const usd = Number(body.amt);
      const cur = Number(body.currencyAmt);
      return (Number.isFinite(usd) && usd > 0) || (Number.isFinite(cur) && cur > 0) ? 'paid' : 'ignore';
    }
    return 'unknown';
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
  if (style === 'torox') {
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
  if (style === 'cpx') {
    // Credit from publisher USD ({amount_usd}), never {amount_local}.
    const usd = Number(body.amount_usd);
    const offer = first(body, ['offer_ID', 'offer_id', 'offerid']);
    return {
      uid: body.user_id != null && body.user_id !== '' ? String(body.user_id) : undefined,
      txid: body.trans_id != null && body.trans_id !== '' ? String(body.trans_id) : undefined,
      partnerUsd: Number.isFinite(usd) ? Math.abs(usd) : 0,
      offerId: offer != null ? String(offer) : undefined,
      sourceHint: undefined,
      status: parseStatus(style, body)
    };
  }
  if (style === 'ayet') {
    // Credit from publisher USD ({payout_usd}); reversals reuse the original id with "r-" in front.
    const usd = Number(first(body, ['payout_usd', 'payout']));
    const tx = first(body, ['transaction_id', 'txid']);
    const uid = first(body, ['external_identifier', 'externalIdentifier', 'uid']);
    const offer = first(body, ['offer_id', 'survey_id']);
    return {
      uid: uid != null ? String(uid) : undefined,
      txid: tx != null ? String(tx).trim().replace(/^r-/i, '') : undefined,
      partnerUsd: Number.isFinite(usd) ? Math.abs(usd) : 0,
      offerId: offer != null ? String(offer) : undefined,
      sourceHint: String(body.is_survey) === '1' ? 'survey' : 'offer',
      status: parseStatus(style, body)
    };
  }
  if (style === 'theoremreach') {
    const usd = Number(first(body, ['reward_amount_in_dollars', 'currency', 'usd', 'payout_usd']));
    const tx = first(body, ['tx_id', 'transaction_id']);
    const offer = first(body, ['offer_id', 'campaign_id']);
    return {
      uid: body.user_id != null && body.user_id !== '' ? String(body.user_id) : undefined,
      txid: tx != null ? String(tx) : undefined,
      partnerUsd: Number.isFinite(usd) ? Math.abs(usd) : 0,
      offerId: offer != null ? String(offer) : undefined,
      sourceHint: String(body.offer).toLowerCase() === 'true' ? 'offer' : 'survey',
      status: parseStatus(style, body)
    };
  }
  if (style === 'rapidoreach') {
    // Credit from publisher USD ({amt}), never currencyAmt.
    const usd = Number(body.amt);
    const tx = first(body, ['transactionId', 'offerInvitationId']);
    return {
      uid: body.endUserId != null && body.endUserId !== '' ? String(body.endUserId) : undefined,
      txid: tx != null ? String(tx) : undefined,
      partnerUsd: Number.isFinite(usd) ? Math.abs(usd) : 0,
      offerId: undefined,
      sourceHint: 'survey',
      status: parseStatus(style, body)
    };
  }
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
  else if (style === 'ayet') v = verifyAyet(req, secret);
  else if (style === 'theoremreach') v = verifyTheoremreach(req, secret, publicBaseUrl, partnerCfg.callbackBases);
  else if (style === 'rapidoreach') v = verifyRapidoreach(body, secret, partnerCfg.appKey);
  else v = verifyGeneric(body, secret);

  if (!v.ok) return { ok: false, reason: v.reason, http: 403 };
  const fields = parseFields(style, body);
  if (!fields.uid || !fields.txid) {
    return { ok: false, reason: 'missing user or transaction id', http: 400, fields };
  }
  if (fields.status === 'unknown') {
    return { ok: false, reason: 'unknown status', http: 400, fields };
  }
  return { ok: true, fields, body };
}

module.exports = {
  hmac, md5, timingSafeEqual, verifyAndParse, signGeneric, parseFields, parseStatus,
  verifyBitlabs, verifyAdgem, verifyCpx, verifyGeneric, verifyLootably, verifyTorox, buildFullUrl, cpxWallUrl,
  verifyAyet, signAyet, verifyTheoremreach, theoremHash, verifyRapidoreach,
  ayetWallUrl, theoremreachWallUrl, rapidoreachUid, rapidoreachWallUrl
};
