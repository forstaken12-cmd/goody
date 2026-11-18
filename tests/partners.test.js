'use strict';

// ayeT-Studios, TheoremReach and RapidoReach: wall links, signed postbacks (good and bad),
// idempotency on transaction id, reversals that claw points back, and partner reply formats.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server/app');
const {
  md5, hmac, signAyet, theoremHash, verifyAyet, verifyRapidoreach, parseFields,
  ayetWallUrl, theoremreachWallUrl, rapidoreachUid, rapidoreachWallUrl
} = require('../server/lib/postback');

const AYET_KEY = 'ayet-unit-test-api-key';
const TR_KEY = 'tr-public-api-key';
const TR_SECRET = 'tr-unit-test-secret';
const RR_ID = 'YqyrVnOaFtt';
const RR_KEY = 'rr-unit-test-app-key';
const RR_SECRET = 'rr-unit-test-app-secret';

let app, server, base, cookie, publicId;

function listen(a) {
  return new Promise((resolve) => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
}
function readCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw || []) {
    const m = String(c).match(/goody_session=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}
async function req(method, url, body, headers) {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}
function auth() { return { cookie: 'goody_session=' + cookie }; }
async function available() {
  const me = await req('GET', '/api/me', null, auth());
  return me.data.balance.available;
}

// ayeT: all params, header = HMAC-SHA256(sorted query, API key)
function ayetGet(params, key) {
  const qs = new URLSearchParams(params).toString();
  return req('GET', '/postback/ayet?' + qs, null, { 'X-Ayetstudios-Security-Hash': signAyet(params, key || AYET_KEY) });
}
// TheoremReach: hash = base64url(HMAC-SHA1(secret, full URL before &hash=)), as called on https://goody.day
function trGet(params, secret, signBase) {
  const path = '/postback/theoremreach?' + new URLSearchParams(params).toString();
  const h = theoremHash(secret || TR_SECRET, (signBase || 'https://goody.day') + path);
  return req('GET', path + '&hash=' + h);
}
// RapidoReach: txnHash = md5(tx + App Secret), offerHash = md5(tx + App Key)
function rrGet(params, opts) {
  opts = opts || {};
  const tx = params.transactionId;
  const p = Object.assign({
    cmd: params.status, userId: rapidoreachUid({ userId: params.endUserId, appId: RR_ID, appKey: RR_KEY }),
    offerInvitationId: tx, offerHash: md5(tx + (opts.appKey || RR_KEY)), txnHash: md5(tx + (opts.secret || RR_SECRET)),
    currencyName: 'points', deviceType: 'Desktop', intergrationMethod: 'IFRAME'
  }, params);
  return req('GET', '/postback/rapidoreach?' + new URLSearchParams(p).toString());
}

before(async () => {
  app = await createApp({
    memory: true,
    config: {
      demoPartner: false,
      sharePct: 0.7,
      pointUsd: 0.001,
      adminPassword: 'test-admin',
      partners: {
        cpx: { name: 'CPX Research', secret: '', style: 'cpx', enabled: false },
        ayet: { name: 'ayeT-Studios', secret: AYET_KEY, style: 'ayet', label: 'ayeT-Studios', surveySlot: '31452', offerSlot: '31454', enabled: true, allowedIps: [] },
        theoremreach: { name: 'TheoremReach', secret: TR_SECRET, apiKey: TR_KEY, style: 'theoremreach', label: 'TheoremReach survey', enabled: true, callbackBases: ['https://goody.day'], allowedIps: [] },
        rapidoreach: { name: 'RapidoReach', secret: RR_SECRET, appKey: RR_KEY, appId: RR_ID, style: 'rapidoreach', source: 'survey', label: 'RapidoReach survey', successBody: '1', enabled: true, allowedIps: [] }
      }
    }
  });
  server = await listen(app);
  base = 'http://127.0.0.1:' + server.address().port;
  const ses = await fetch(base + '/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'partners@example.com', password: 'password12', agreeTerms: true, ageConfirm: true })
  });
  const data = await ses.json();
  assert.equal(ses.status, 200, JSON.stringify(data));
  cookie = readCookie(ses);
  publicId = data.user.publicId;
});

after(async () => {
  if (app && app.close) await app.close();
  if (server) await new Promise((r) => server.close(r));
});

// ----- unit -----

test('wall links match each partner\'s documented format', () => {
  const s = new URL(ayetWallUrl({ kind: 'surveys', adSlot: '31452', extUserId: 'u_abc' }));
  assert.equal(s.origin + s.pathname, 'https://surveys.ayet.io/surveys');
  assert.equal(s.searchParams.get('adSlot'), '31452');
  assert.equal(s.searchParams.get('external_identifier'), 'u_abc');
  const o = new URL(ayetWallUrl({ kind: 'offers', adSlot: '31454', extUserId: 'u_abc' }));
  assert.equal(o.origin + o.pathname, 'https://offerwall.ayet.io/offers');
  assert.equal(o.searchParams.get('externalIdentifier'), 'u_abc');

  const tr = theoremreachWallUrl({ apiKey: TR_KEY, secret: TR_SECRET, userId: 'u_abc', transactionId: 't1' });
  const i = tr.lastIndexOf('&hash=');
  assert.equal(tr.slice(i + 6), theoremHash(TR_SECRET, tr.slice(0, i)));
  const tu = new URL(tr);
  assert.equal(tu.origin + tu.pathname, 'https://theoremreach.com/respondent_entry/direct');
  assert.equal(tu.searchParams.get('api_key'), TR_KEY);
  assert.equal(tu.searchParams.get('user_id'), 'u_abc');
  assert.ok(!tr.includes(TR_SECRET));

  assert.equal(rapidoreachUid({ userId: 'u_abc', appId: RR_ID, appKey: RR_KEY }), 'u_abc-' + RR_ID + '-' + md5('u_abc-' + RR_ID + '-' + RR_KEY));
  const rr = rapidoreachWallUrl({ userId: 'u_abc', appId: RR_ID, appKey: RR_KEY });
  assert.ok(rr.startsWith('https://www.rapidoreach.com/ofw/?userId=u_abc-' + RR_ID + '-'));
  assert.ok(!rr.includes(RR_KEY));
});

test('theoremHash is URL-safe base64 of raw HMAC-SHA1 with no padding', () => {
  const raw = crypto.createHmac('sha1', 'k').update('x').digest('base64');
  assert.equal(theoremHash('k', 'x'), raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  assert.ok(!/[+/=]/.test(theoremHash('k', 'anything at all')));
});

test('ayeT header check accepts PHP http_build_query encoding (space as +) and rejects tampering', () => {
  const params = { b: 'x y', a: '1', offer_name: "Bob's game*" };
  const php = 'a=1&b=x+y&offer_name=Bob%27s+game%2A';
  const mk = (qs, h) => ({ originalUrl: '/postback/ayet?' + qs, headers: { 'x-ayetstudios-security-hash': h }, get(n) { return this.headers[n.toLowerCase()]; } });
  const qs = new URLSearchParams(params).toString();
  assert.equal(verifyAyet(mk(qs, hmac('sha256', AYET_KEY, php, 'hex')), AYET_KEY).ok, true);
  assert.equal(verifyAyet(mk(qs, signAyet(params, AYET_KEY)), AYET_KEY).ok, true);
  assert.equal(verifyAyet(mk(qs.replace('a=1', 'a=2'), signAyet(params, AYET_KEY)), AYET_KEY).ok, false);
  assert.equal(verifyAyet(mk(qs, ''), AYET_KEY).ok, false);
});

test('RapidoReach needs txnHash; offerHash is checked when sent', () => {
  assert.equal(verifyRapidoreach({ transactionId: 'T', txnHash: md5('T' + RR_SECRET), offerHash: md5('T' + RR_KEY) }, RR_SECRET, RR_KEY).ok, true);
  assert.equal(verifyRapidoreach({ transactionId: 'T', txnHash: md5('T' + RR_SECRET).toUpperCase() }, RR_SECRET, RR_KEY).ok, true);
  assert.equal(verifyRapidoreach({ transactionId: 'T', txnHash: md5('T' + RR_SECRET), offerHash: 'nope' }, RR_SECRET, RR_KEY).ok, false);
  assert.equal(verifyRapidoreach({ transactionId: 'T', offerHash: md5('T' + RR_KEY) }, RR_SECRET, RR_KEY).ok, false);
  assert.equal(verifyRapidoreach({ transactionId: 'T2', txnHash: md5('T' + RR_SECRET) }, RR_SECRET, RR_KEY).ok, false);
});

test('ayeT reversal ids drop the "r-" prefix so they match the original credit', () => {
  const f = parseFields('ayet', { external_identifier: 'u', transaction_id: 'r-abc', payout_usd: '-0.5', is_chargeback: '1' });
  assert.equal(f.txid, 'abc');
  assert.equal(f.partnerUsd, 0.5);
  assert.equal(f.status, 'reversal');
});

// ----- HTTP -----

test('config lists the walls; each wall link needs a session', async () => {
  const cfg = await req('GET', '/api/config');
  for (const k of ['theoremreach', 'rapidoreach', 'ayet_surveys', 'ayet_offers']) assert.equal(cfg.data.walls[k], true, k);
  assert.equal(cfg.data.walls.cpx, false);
  assert.equal((await req('GET', '/api/walls/theoremreach')).status, 401);
  for (const k of ['theoremreach', 'rapidoreach', 'ayet_surveys', 'ayet_offers']) {
    const w = await req('GET', '/api/walls/' + k, null, auth());
    assert.equal(w.status, 200, k + ' ' + w.text);
    assert.ok(w.data.url.includes(publicId), k);
  }
  assert.equal((await req('GET', '/api/walls/cpx', null, auth())).status, 503);
  assert.equal((await req('GET', '/api/walls/nope', null, auth())).status, 404);
});

test('ayeT: signed callback credits 700 pts per $1, replay is idempotent, r- chargeback claws back', async () => {
  const start = await available();
  const p = { network: 'ayetstudios', external_identifier: publicId, transaction_id: 'ay-1', payout_usd: '1.00', currency_amount: '700', is_chargeback: '0', offer_id: '55', is_survey: '1' };
  const bad = await ayetGet(p, 'wrong-key');
  assert.equal(bad.status, 403);
  const unsigned = await req('GET', '/postback/ayet?' + new URLSearchParams(p).toString());
  assert.equal(unsigned.status, 403);
  const ok = await ayetGet(p);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.action, 'paid');
  assert.equal(await available(), start + 700);
  const again = await ayetGet(p);
  assert.equal(again.status, 200);
  assert.equal(again.data.idempotent, true);
  assert.equal(await available(), start + 700);
  const cb = await ayetGet(Object.assign({}, p, { transaction_id: 'r-ay-1', payout_usd: '-1.00', currency_amount: '-700', is_chargeback: '1', chargeback_reason: 'fraud' }));
  assert.equal(cb.status, 200, cb.text);
  assert.equal(cb.data.action, 'reversed');
  assert.equal(await available(), start);
});

test('TheoremReach: signed callback credits, debug ignored, bad hash 403, reversal claws back', async () => {
  const start = await available();
  const p = { reward: '350', currency: '0.50', user_id: publicId, tx_id: 'tr-1', transaction_id: 'g1', screenout: '2', offer: 'false' };
  const bad = await trGet(p, 'wrong-secret');
  assert.equal(bad.status, 403);
  const none = await req('GET', '/postback/theoremreach?' + new URLSearchParams(p).toString());
  assert.equal(none.status, 403);
  const dbg = await trGet(Object.assign({}, p, { tx_id: 'tr-debug', debug: 'true' }));
  assert.equal(dbg.status, 200, dbg.text);
  assert.equal(dbg.data.action, 'ignored');
  assert.equal(await available(), start);
  const ok = await trGet(p);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.action, 'paid');
  assert.equal(await available(), start + 350);
  // Signed against the local address also works (PUBLIC_BASE_URL / Host).
  const again = await trGet(p, null, base);
  assert.equal(again.status, 200);
  assert.equal(again.data.idempotent, true);
  assert.equal(await available(), start + 350);
  const rev = await trGet(Object.assign({}, p, { reward: '-350', currency: '-0.50', reversal: 'true' }));
  assert.equal(rev.status, 200, rev.text);
  assert.equal(rev.data.action, 'reversed');
  assert.equal(await available(), start);
});

test('RapidoReach: C credits and answers "1", F with no pay is ignored, bad hash 403, R claws back', async () => {
  const start = await available();
  const p = { transactionId: 'rr-1', endUserId: publicId, status: 'C', amt: '2.00', currencyAmt: '1400' };
  const bad = await rrGet(p, { secret: 'wrong' });
  assert.equal(bad.status, 403);
  const badOffer = await rrGet(p, { appKey: 'wrong' });
  assert.equal(badOffer.status, 403);
  const ok = await rrGet(p);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '1');
  assert.equal(await available(), start + 1400);
  const again = await rrGet(p);
  assert.equal(again.status, 200);
  assert.equal(again.text, '1');
  assert.equal(await available(), start + 1400);
  const so = await rrGet({ transactionId: 'rr-2', endUserId: publicId, status: 'F', amt: '0', currencyAmt: '0' });
  assert.equal(so.status, 200);
  assert.equal(await available(), start + 1400);
  const paidSo = await rrGet({ transactionId: 'rr-3', endUserId: publicId, status: 'F', amt: '0.10', currencyAmt: '70' });
  assert.equal(paidSo.status, 200);
  assert.equal(await available(), start + 1470);
  const rev = await rrGet({ transactionId: 'rr-1', endUserId: publicId, status: 'R', amt: '-2.00', currencyAmt: '-1400' });
  assert.equal(rev.status, 200);
  assert.equal(await available(), start + 70);
  const unknown = await rrGet({ transactionId: 'rr-4', endUserId: 'u_nobody', status: 'C', amt: '1' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.text, '0');
});

test('partners without secrets stay off: walls hidden and postbacks refused', async () => {
  const off = await createApp({
    memory: true,
    config: {
      demoPartner: false,
      partners: {
        ayet: { name: 'ayeT-Studios', secret: '', style: 'ayet', surveySlot: '31452', offerSlot: '31454', enabled: false },
        theoremreach: { name: 'TheoremReach', secret: '', apiKey: TR_KEY, style: 'theoremreach', enabled: false },
        rapidoreach: { name: 'RapidoReach', secret: '', appKey: '', appId: RR_ID, style: 'rapidoreach', successBody: '1', enabled: false }
      }
    }
  });
  const s = await listen(off);
  const b = 'http://127.0.0.1:' + s.address().port;
  try {
    const cfg = await (await fetch(b + '/api/config')).json();
    for (const k of ['theoremreach', 'rapidoreach', 'ayet_surveys', 'ayet_offers']) assert.equal(cfg.walls[k], false, k);
    for (const k of ['ayet', 'theoremreach', 'rapidoreach']) {
      const r = await fetch(b + '/postback/' + k + '?transactionId=x&tx_id=x&transaction_id=x');
      assert.notEqual(r.status, 200, k);
    }
  } finally {
    if (off.close) await off.close();
    await new Promise((r) => s.close(r));
  }
});
