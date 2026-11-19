'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, methodMinUsd } = require('../server/app');
const { openDb } = require('../server/db');
const ledger = require('../server/lib/ledger');
const { signup } = require('../server/lib/auth');

const SHARE = 0.7;
const PV = 0.001;

const servers = [];
after(() => { for (const s of servers) s.close(); });

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function partnerUsdFor(points) {
  return points * PV / SHARE;
}

async function makeUser(db, email) {
  const r = await signup(db, {
    email,
    password: 'password12',
    agreeTerms: true,
    ageConfirm: true
  }, {});
  return r.user;
}

test('methodMinUsd uses the overall floor and keeps method or first mins when they are higher', () => {
  const cfg = { minCashoutUsd: 5, firstCashoutUsd: 0.5, mins: { lightning: 0.8, paypal: 1.2, gift: 2 } };
  assert.equal(methodMinUsd(cfg, 'gift', true), 5);
  assert.equal(methodMinUsd(cfg, 'gift', false), 5);
  assert.equal(methodMinUsd(cfg, 'paypal', false), 5);
  const lowFloor = { minCashoutUsd: 0, firstCashoutUsd: 0.5, mins: { lightning: 0.8, paypal: 1.2, gift: 2 } };
  assert.equal(methodMinUsd(lowFloor, 'gift', true), 0.5);
  assert.equal(methodMinUsd(lowFloor, 'gift', false), 2);
  assert.equal(methodMinUsd(lowFloor, 'paypal', false), 1.2);
  const highGift = { minCashoutUsd: 5, firstCashoutUsd: 0.5, mins: { lightning: 0.8, paypal: 1.2, gift: 10 } };
  assert.equal(methodMinUsd(highGift, 'gift', false), 10);
  assert.equal(methodMinUsd(highGift, 'gift', true), 5);
});

test('migrate adds available_at; existing paid credits with no release time stay available', async () => {
  const db = await openDb({ memory: true });
  const cols = await db.all(
    db.dialect === 'pg'
      ? `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'ledger'`
      : 'PRAGMA table_info(ledger)'
  );
  assert.ok(cols.some((c) => c.name === 'available_at'));
  const user = await makeUser(db, 'legacy@example.com');
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ledger (user_id, entry_type, status, source, partner, offer_id, tx_id, partner_usd, user_usd, points, note, available_at, created_at, updated_at)
     VALUES (?, 'credit', 'paid', 'offer', 'demo', 'old', 'legacy-tx', 1, 0.7, 700, 'old balance', NULL, ?, ?)`,
    [user.id, now, now]
  );
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 700);
  assert.equal(b.pending, 0);
  await db.close();
});

test('a paid postback with a hold starts pending and is not cash-out-able yet', async () => {
  const db = await openDb({ memory: true });
  const user = await makeUser(db, 'hold@example.com');
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'hold-1', offerId: 's1',
    source: 'survey', partnerUsd: 1, status: 'paid', sharePct: SHARE, pointUsd: PV, holdDays: 3
  });
  assert.equal(r.action, 'held');
  assert.equal(r.entry.status, 'pending');
  assert.ok(r.entry.available_at);
  const release = new Date(r.entry.available_at).getTime();
  const delta = release - Date.now();
  assert.ok(delta > 2.5 * 24 * 60 * 60 * 1000 && delta < 3.5 * 24 * 60 * 60 * 1000);
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
  assert.equal(b.pending, 700);
  assert.equal(b.checking, 0);
  assert.equal(b.nextReleasePoints, 700);
  assert.equal(b.nextReleaseAt, r.entry.available_at);
  await db.close();
});

test('reversal during the hold removes the pending points', async () => {
  const db = await openDb({ memory: true });
  const user = await makeUser(db, 'revhold@example.com');
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'rev-hold', offerId: 's1',
    source: 'survey', partnerUsd: 1, status: 'paid', sharePct: SHARE, pointUsd: PV, holdDays: 3
  });
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'rev-hold', offerId: 's1',
    source: 'survey', partnerUsd: 1, status: 'reversal', sharePct: SHARE, pointUsd: PV, holdDays: 3
  });
  assert.equal(r.action, 'reversed');
  assert.equal(r.entry.status, 'rejected');
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
  assert.equal(b.pending, 0);
  await db.close();
});

test('after the hold, points become available; a later reversal still claws them back', async () => {
  const db = await openDb({ memory: true });
  const user = await makeUser(db, 'release@example.com');
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'rel-1', offerId: 's1',
    source: 'survey', partnerUsd: 1, status: 'paid', sharePct: SHARE, pointUsd: PV, holdDays: 3
  });
  await db.run('UPDATE ledger SET available_at = ? WHERE tx_id = ?', [daysAgoIso(0.01), 'rel-1']);
  let b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 700);
  assert.equal(b.pending, 0);
  const row = await ledger.findByTx(db, 'cpx', 'rel-1');
  assert.equal(row.status, 'paid');
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'rel-1', offerId: 's1',
    source: 'survey', partnerUsd: 1, status: 'reversal', sharePct: SHARE, pointUsd: PV
  });
  b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
  await db.close();
});

test('a reversal after a cash-out can make the available balance negative', async () => {
  const db = await openDb({ memory: true });
  const user = await makeUser(db, 'neg@example.com');
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'neg-1', offerId: 's1',
    source: 'survey', partnerUsd: partnerUsdFor(5000), status: 'paid', sharePct: SHARE, pointUsd: PV, holdDays: 0
  });
  const debit = await ledger.holdDebit(db, { userId: user.id, source: 'cashout', points: 5000, usd: 5 });
  await ledger.settleDebit(db, debit.id, 'paid');
  let b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'neg-1', offerId: 's1',
    source: 'survey', partnerUsd: partnerUsdFor(5000), status: 'reversal', sharePct: SHARE, pointUsd: PV
  });
  b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, -5000);
  await db.close();
});

test('holdDays 0 still credits immediately, same as older behavior', async () => {
  const db = await openDb({ memory: true });
  const user = await makeUser(db, 'now@example.com');
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'cpx', txId: 'now-1', offerId: 's1',
    source: 'survey', partnerUsd: 1, status: 'paid', sharePct: SHARE, pointUsd: PV, holdDays: 0
  });
  assert.equal(r.action, 'paid');
  assert.equal(r.entry.status, 'paid');
  assert.equal(r.entry.available_at, null);
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 700);
  await db.close();
});

test('settling a checking credit applies the hold instead of paying immediately', async () => {
  const db = await openDb({ memory: true });
  const user = await makeUser(db, 'settle@example.com');
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 'set-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1, status: 'pending', sharePct: SHARE, pointUsd: PV
  });
  let b = await ledger.balanceOf(db, user.id);
  assert.equal(b.checking, 700);
  assert.equal(b.available, 0);
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 'set-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1, status: 'paid', sharePct: SHARE, pointUsd: PV, holdDays: 3
  });
  assert.equal(r.action, 'held');
  assert.equal(r.entry.status, 'pending');
  assert.ok(r.entry.available_at);
  b = await ledger.balanceOf(db, user.id);
  assert.equal(b.checking, 0);
  assert.equal(b.pending, 700);
  assert.equal(b.available, 0);
  await db.close();
});

let userSeq = 0;
async function startApp(extraCfg) {
  const app = await createApp({
    memory: true,
    config: Object.assign({
      demoPartner: false,
      sharePct: SHARE,
      pointUsd: PV,
      firstCashoutUsd: 0.5,
      minCashoutUsd: 5,
      earnHoldDays: 3,
      payoutAutoApprove: false,
      publicBaseUrl: 'http://127.0.0.1',
      secureCookies: false,
      adminPassword: 'test-admin',
      partners: {
        demo: { name: 'Demo', secret: 'policy-secret', style: 'generic', enabled: true }
      }
    }, extraCfg || {})
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(method, path, body, headers) {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const cookie = (res.headers.getSetCookie() || []).map((c) => (c.match(/goody_session=([^;]+)/) || [])[1]).find(Boolean);
    return { status: res.status, data: await res.json().catch(() => ({})), cookie };
  }
  return { app, base, call };
}

async function signedIn(ctx, points, opts) {
  const email = 'policy' + (++userSeq) + '@example.com';
  const su = await ctx.call('POST', '/api/auth/signup', { email, password: 'password12', agreeTerms: true, ageConfirm: true });
  assert.equal(su.status, 200, su.data);
  const db = ctx.app.locals.db;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  if (points) {
    const holdDays = opts && Object.prototype.hasOwnProperty.call(opts, 'holdDays') ? opts.holdDays : 0;
    await ctx.app.locals.ledger.applyPostback(db, {
      userId: user.id, partner: 'demo', txId: 'pol-' + userSeq, offerId: 'x',
      source: 'offer', partnerUsd: partnerUsdFor(points), status: 'paid',
      sharePct: SHARE, pointUsd: PV, holdDays
    });
  }
  return { user, headers: { cookie: 'goody_session=' + su.cookie } };
}

async function adminHeaders(ctx) {
  const a = await ctx.call('POST', '/admin/login', { password: 'test-admin' });
  assert.equal(a.status, 200, a.data);
  return { 'x-admin-token': a.data.token };
}

test('/api/config and /api/me expose the hold and the cash-out minimum', async () => {
  const ctx = await startApp();
  const cfg = await ctx.call('GET', '/api/config');
  assert.equal(cfg.data.minCashoutUsd, 5);
  assert.equal(cfg.data.earnHoldDays, 3);
  const { headers } = await signedIn(ctx, 700, { holdDays: 3 });
  const me = await ctx.call('GET', '/api/me', null, headers);
  assert.equal(me.data.minCashoutUsd, 5);
  assert.equal(me.data.earnHoldDays, 3);
  assert.equal(me.data.balance.available, 0);
  assert.equal(me.data.balance.pending, 700);
  assert.ok(me.data.balance.nextReleaseAt);
  const hist = await ctx.call('GET', '/api/history', null, headers);
  assert.equal(hist.data.entries[0].status, 'pending');
  assert.ok(hist.data.entries[0].availableAt);
});

test('pending points cannot be cashed out until the hold is over', async () => {
  const ctx = await startApp({ minCashoutUsd: 0, firstCashoutUsd: 0.5 });
  const { headers, user } = await signedIn(ctx, 700, { holdDays: 3 });
  const blocked = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 700 }, headers);
  assert.equal(blocked.status, 400);
  await ctx.app.locals.db.run('UPDATE ledger SET available_at = ? WHERE user_id = ?', [daysAgoIso(0.01), user.id]);
  const ok = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 700 }, headers);
  assert.equal(ok.status, 200, ok.data);
  assert.equal(ok.data.cashout.status, 'requested');
  assert.equal(ok.data.balance.held, 700);
  assert.equal(ok.data.balance.available, 0);
});

test('the $5 cash-out minimum is enforced on the server', async () => {
  const ctx = await startApp();
  const { headers } = await signedIn(ctx, 6000, { holdDays: 0 });
  const tooSmall = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 500 }, headers);
  assert.equal(tooSmall.status, 400);
  assert.match(String(tooSmall.data.error), /5\.00|5000/i);
  const ok = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 5000 }, headers);
  assert.equal(ok.status, 200, ok.data);
  assert.equal(ok.data.cashout.points, 5000);
  assert.equal(ok.data.cashout.status, 'requested');
});

test('a second cash-out cannot spend points already reserved', async () => {
  const ctx = await startApp();
  const { headers } = await signedIn(ctx, 5000, { holdDays: 0 });
  const first = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 5000 }, headers);
  assert.equal(first.status, 200, first.data);
  const second = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 5000 }, headers);
  assert.equal(second.status, 400);
  assert.equal(first.data.balance.held, 5000);
  assert.equal(first.data.balance.available, 0);
});

test('admin approve and reject use the existing admin password; reject returns the points', async () => {
  const ctx = await startApp();
  const { headers, user } = await signedIn(ctx, 5000, { holdDays: 0 });
  const co = await ctx.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 5000 }, headers);
  assert.equal(co.data.cashout.status, 'requested');
  const list = await ctx.call('GET', '/api/cashouts', null, headers);
  assert.equal(list.data.cashouts[0].status, 'requested');

  const noAuth = await ctx.call('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/approve', {});
  assert.equal(noAuth.status, 401);

  const admin = await adminHeaders(ctx);
  const reject = await ctx.call('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/reject', { note: 'nope' }, admin);
  assert.equal(reject.status, 200, reject.data);
  assert.equal(reject.data.cashout.status, 'rejected');
  const b = await ctx.app.locals.ledger.balanceOf(ctx.app.locals.db, user.id);
  assert.equal(b.available, 5000);
  assert.equal(b.held, 0);
});

test('PAYOUT_AUTO_APPROVE left off keeps cash outs under review; turning it on approves without an admin click', async () => {
  const off = await startApp({ payoutAutoApprove: false, earnHoldDays: 0 });
  const u1 = await signedIn(off, 5000, { holdDays: 0 });
  const requested = await off.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 5000 }, u1.headers);
  assert.equal(requested.data.cashout.status, 'requested');

  const on = await startApp({ payoutAutoApprove: true, earnHoldDays: 0 });
  const u2 = await signedIn(on, 5000, { holdDays: 0 });
  const auto = await on.call('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 5000 }, u2.headers);
  assert.equal(auto.status, 200, auto.data);
  assert.equal(auto.data.cashout.status, 'approved');
  assert.equal(auto.data.cashout.payout_mode, 'manual');
});
