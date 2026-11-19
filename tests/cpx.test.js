'use strict';

// CPX Research: survey wall link, postback hash checks, idempotency, reversals.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { md5, verifyCpx, parseStatus, parseFields, cpxWallUrl } = require('../server/lib/postback');

const CPX_SECRET = 'cpx-unit-test-hash-0123456789ab';
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
  return { status: res.status, data, cookie: readCookie(res) };
}
function auth() { return { cookie: 'goody_session=' + cookie }; }
function cpxQuery(o) {
  const p = Object.assign({ user_id: publicId, amount_local: '500', offer_ID: '1234' }, o);
  if (p.hash === undefined) p.hash = md5(String(p.trans_id) + '-' + CPX_SECRET);
  return new URLSearchParams(p).toString();
}
async function available() {
  const me = await req('GET', '/api/me', null, auth());
  return me.data.balance.available;
}

before(async () => {
  app = await createApp({
    memory: true,
    config: {
      demoPartner: false,
      sharePct: 0.7,
      pointUsd: 0.001,
      firstCashoutUsd: 0.5,
      earnHoldDays: 0,
      minCashoutUsd: 0,
      adminPassword: 'test-admin',
      partners: {
        cpx: { name: 'CPX Research', secret: CPX_SECRET, appId: '38062', style: 'cpx', source: 'survey', label: 'CPX Research survey', enabled: true, allowedIps: [] }
      }
    }
  });
  server = await listen(app);
  base = 'http://127.0.0.1:' + server.address().port;
  const ses = await req('POST', '/api/auth/signup', {
    email: 'cpx@example.com', password: 'password12', agreeTerms: true, ageConfirm: true
  });
  assert.equal(ses.status, 200, ses.data);
  cookie = ses.cookie;
  publicId = ses.data.user.publicId;
});

after(async () => {
  if (app && app.close) await app.close();
  if (server) await new Promise((r) => server.close(r));
});

// ----- unit -----

test('verifyCpx: md5(trans_id + "-" + security hash), hash= or secure_hash=', () => {
  const good = md5('T1-' + CPX_SECRET);
  assert.equal(verifyCpx({ trans_id: 'T1', hash: good }, CPX_SECRET).ok, true);
  assert.equal(verifyCpx({ trans_id: 'T1', secure_hash: good }, CPX_SECRET).ok, true);
  assert.equal(verifyCpx({ trans_id: 'T2', hash: good }, CPX_SECRET).ok, false);
  assert.equal(verifyCpx({ trans_id: 'T1', hash: good }, 'other-secret').ok, false);
  assert.equal(verifyCpx({ trans_id: 'T1', hash: good.toUpperCase() }, CPX_SECRET).ok, false);
  assert.equal(verifyCpx({ trans_id: 'T1' }, CPX_SECRET).ok, false);
  assert.equal(verifyCpx({ hash: good }, CPX_SECRET).ok, false);
});

test('parseStatus: 1 = paid, 2 = reversal, anything else unknown', () => {
  assert.equal(parseStatus('cpx', { status: '1' }), 'paid');
  assert.equal(parseStatus('cpx', { status: '2' }), 'reversal');
  assert.equal(parseStatus('cpx', { status: '0' }), 'unknown');
  assert.equal(parseStatus('cpx', {}), 'unknown');
});

test('parseFields: credits amount_usd, never amount_local', () => {
  const f = parseFields('cpx', { user_id: 'u_x', trans_id: 'T9', amount_usd: '0.42', amount_local: '999', offer_ID: '77', status: '1' });
  assert.equal(f.uid, 'u_x');
  assert.equal(f.txid, 'T9');
  assert.equal(f.partnerUsd, 0.42);
  assert.equal(f.offerId, '77');
  assert.equal(f.status, 'paid');
});

test('cpxWallUrl: app_id, ext_user_id, secure_hash = md5(ext_user_id + "-" + hash)', () => {
  const u = new URL(cpxWallUrl({ appId: '38062', secret: CPX_SECRET, extUserId: 'u_abc' }));
  assert.equal(u.origin + u.pathname, 'https://offers.cpx-research.com/index.php');
  assert.equal(u.searchParams.get('app_id'), '38062');
  assert.equal(u.searchParams.get('ext_user_id'), 'u_abc');
  assert.equal(u.searchParams.get('secure_hash'), md5('u_abc-' + CPX_SECRET));
  assert.ok(!u.toString().includes(CPX_SECRET));
});

// ----- HTTP -----

test('config says the CPX wall is on; wall link needs a session', async () => {
  const cfg = await req('GET', '/api/config');
  assert.equal(cfg.data.demo, false);
  assert.equal(cfg.data.walls.cpx, true);
  const anon = await req('GET', '/api/walls/cpx');
  assert.equal(anon.status, 401);
  const w = await req('GET', '/api/walls/cpx', null, auth());
  assert.equal(w.status, 200, w.data);
  const u = new URL(w.data.url);
  assert.equal(u.searchParams.get('ext_user_id'), publicId);
  assert.equal(u.searchParams.get('secure_hash'), md5(publicId + '-' + CPX_SECRET));
  assert.ok(!JSON.stringify(w.data).includes(CPX_SECRET));
});

test('bad or missing hash is rejected with 403 and credits nothing', async () => {
  const before = await available();
  let r = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'bad-1', amount_usd: '1', status: '1', hash: 'deadbeef' }));
  assert.equal(r.status, 403);
  r = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'bad-2', amount_usd: '1', status: '1', hash: '' }));
  assert.equal(r.status, 403);
  // hash signed for a different trans_id
  r = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'bad-3', amount_usd: '1', status: '1', hash: md5('other-' + CPX_SECRET) }));
  assert.equal(r.status, 403);
  assert.equal(await available(), before);
});

test('unknown user or unknown status is refused', async () => {
  let r = await req('GET', '/postback/cpx?' + cpxQuery({ user_id: 'u_nobody', trans_id: 'nouser-1', amount_usd: '1', status: '1' }));
  assert.equal(r.status, 400);
  r = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'weird-1', amount_usd: '1', status: '7' }));
  assert.equal(r.status, 400);
});

test('status 1 credits 70% of amount_usd once; replays are idempotent', async () => {
  const start = await available();
  const q = cpxQuery({ trans_id: 'cpx-T100', amount_usd: '1.00', status: '1' });
  const r1 = await req('GET', '/postback/cpx?' + q);
  assert.equal(r1.status, 200, r1.data);
  assert.equal(r1.data.action, 'paid');
  assert.equal(await available(), start + 700);
  const r2 = await req('GET', '/postback/cpx?' + q);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.action, 'duplicate');
  assert.equal(r2.data.idempotent, true);
  const r3 = await req('POST', '/postback/cpx', Object.fromEntries(new URLSearchParams(q)));
  assert.equal(r3.status, 200);
  assert.equal(r3.data.idempotent, true);
  assert.equal(await available(), start + 700);

  const row = await app.locals.db.get('SELECT * FROM ledger WHERE partner = ? AND tx_id = ?', ['cpx', 'cpx-T100']);
  assert.equal(row.source, 'survey');
  assert.equal(row.note, 'CPX Research survey');
  assert.equal(row.offer_id, '1234');
  assert.equal(Number(row.partner_usd), 1);
});

test('status 2 reverses the credit once; a late status 1 cannot revive it', async () => {
  const start = await available();
  await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T200', amount_usd: '0.50', status: '1' }));
  assert.equal(await available(), start + 350);
  const rev = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T200', amount_usd: '0.50', status: '2' }));
  assert.equal(rev.status, 200);
  assert.equal(rev.data.action, 'reversed');
  assert.equal(await available(), start);
  const rev2 = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T200', amount_usd: '0.50', status: '2' }));
  assert.equal(rev2.data.idempotent, true);
  const late = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T200', amount_usd: '0.50', status: '1' }));
  assert.equal(late.data.action, 'ignored-after-reversal');
  assert.equal(await available(), start);
});

test('a reversal after the points were spent leaves a negative balance (cash-out blocked)', async () => {
  const user = await app.locals.db.get('SELECT * FROM users WHERE public_id = ?', [publicId]);
  await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T300', amount_usd: '2.00', status: '1' }));
  const avail = await available();
  // Spend everything (as a held cash-out would), then CPX cancels the survey.
  await app.locals.ledger.holdDebit(app.locals.db, { userId: user.id, source: 'cashout', points: avail, usd: avail / 1000, note: 'test hold' });
  assert.equal(await available(), 0);
  const rev = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T300', amount_usd: '2.00', status: '2' }));
  assert.equal(rev.data.action, 'reversed');
  assert.equal(await available(), -1400);
});

test('reversal with no prior credit is logged and blocks a later credit', async () => {
  const start = await available();
  const r = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T400', amount_usd: '0.30', status: '2' }));
  assert.equal(r.data.action, 'logged-reversal');
  const late = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T400', amount_usd: '0.30', status: '1' }));
  assert.equal(late.data.action, 'ignored-after-reversal');
  assert.equal(await available(), start);
});

test('optional IP allow-list blocks other senders', async () => {
  app.locals.config.partners.cpx.allowedIps = ['203.0.113.9'];
  try {
    const r = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T500', amount_usd: '0.30', status: '1' }));
    assert.equal(r.status, 403);
  } finally {
    app.locals.config.partners.cpx.allowedIps = [];
  }
  const ok = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T500', amount_usd: '0.30', status: '1' }));
  assert.equal(ok.status, 200);
});

test('wall is hidden and the link refused when no security hash is set', async () => {
  const saved = app.locals.config.partners.cpx.secret;
  app.locals.config.partners.cpx.secret = '';
  try {
    const cfg = await req('GET', '/api/config');
    assert.equal(cfg.data.walls.cpx, false);
    const w = await req('GET', '/api/walls/cpx', null, auth());
    assert.equal(w.status, 503);
    const pb = await req('GET', '/postback/cpx?' + cpxQuery({ trans_id: 'cpx-T600', amount_usd: '0.30', status: '1' }));
    assert.equal(pb.status, 503);
  } finally {
    app.locals.config.partners.cpx.secret = saved;
  }
});
