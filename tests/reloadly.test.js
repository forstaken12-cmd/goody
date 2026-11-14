'use strict';

// Reloadly gift cards with a fake Reloadly server. No real network calls.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const payouts = require('../server/lib/payouts');
const secretBox = require('../server/lib/secretBox');

const SANDBOX = 'https://giftcards-sandbox.reloadly.com';
const LIVE = 'https://giftcards.reloadly.com';
const FAKE_CODE = 'TEST-CODE-1234';
const FAKE_PIN = '9876';

const CATALOG = [
  { productId: 5, productName: 'Amazon US', status: 'ACTIVE', denominationType: 'RANGE', recipientCurrencyCode: 'USD',
    minRecipientDenomination: 5, maxRecipientDenomination: 100, fixedRecipientDenominations: [],
    logoUrls: ['https://cdn.reloadly.com/giftcards/amazon.png'], brand: { brandName: 'Amazon' } },
  { productId: 12740, productName: 'Target US', status: 'ACTIVE', denominationType: 'RANGE', recipientCurrencyCode: 'USD',
    minRecipientDenomination: 1, maxRecipientDenomination: 100, fixedRecipientDenominations: [],
    logoUrls: ['https://cdn.reloadly.com/giftcards/target.png'] },
  { productId: 21, productName: 'Apple US', status: 'ACTIVE', denominationType: 'FIXED', recipientCurrencyCode: 'USD',
    fixedRecipientDenominations: [2, 3, 10, 25], logoUrls: [], brand: { logoUrl: 'https://cdn.reloadly.com/giftcards/apple.png' } },
  { productId: 11500, productName: 'Roblox US', status: 'ACTIVE', denominationType: 'FIXED', recipientCurrencyCode: 'USD',
    fixedRecipientDenominations: [10, 25], logoUrls: ['https://cdn.reloadly.com/giftcards/roblox.png'] },
  { productId: 18285, productName: 'Walmart USA US', status: 'INACTIVE', denominationType: 'RANGE', recipientCurrencyCode: 'USD',
    minRecipientDenomination: 5, maxRecipientDenomination: 100, logoUrls: [] },
  { productId: 777, productName: 'Some Other Store US', status: 'ACTIVE', denominationType: 'RANGE', recipientCurrencyCode: 'USD',
    minRecipientDenomination: 5, maxRecipientDenomination: 50, logoUrls: [] }
];

/** A fake Reloadly. `mode.order` picks how POST /orders behaves. */
function fakeReloadly(mode) {
  const calls = { auth: 0, products: 0, orders: [], cards: 0, audience: [] };
  const orders = new Map();
  let nextTx = 1000;
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  async function fetchFn(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    if (u.href === 'https://auth.reloadly.com/oauth/token') {
      calls.auth++;
      const b = JSON.parse(init.body);
      calls.audience.push(b.audience);
      if (b.client_id !== 'test-id' || b.client_secret !== 'test-secret') return reply(401, { errorCode: 'INVALID_CREDENTIALS', message: 'Access Denied' });
      if (mode.liveOnly && b.audience !== LIVE) return reply(401, { errorCode: 'CREDENTIAL_VS_ENVIRONMENT_MISMATCH', message: 'Access Denied' });
      return reply(200, { access_token: 'tok-' + calls.auth, expires_in: 3600, token_type: 'Bearer' });
    }
    assert.match(String(init.headers.Authorization), /^Bearer tok-\d+$/);
    if (u.pathname === '/countries/US/products') { calls.products++; return reply(200, CATALOG); }
    if (u.pathname === '/orders' && method === 'POST') {
      const b = JSON.parse(init.body);
      calls.orders.push(b);
      const m = mode.order || 'ok';
      if (m === 'hang') {
        return new Promise((_res, rej) => init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'TimeoutError'; rej(e);
        }));
      }
      if (m === 'reject') return reply(400, { errorCode: 'INVALID_UNIT_PRICE', message: 'Bad amount' });
      if (m === 'balance') return reply(400, { errorCode: 'INSUFFICIENT_BALANCE', message: 'Not enough balance' });
      if (m === 'failed') return reply(200, { transactionId: nextTx++, status: 'FAILED', customIdentifier: b.customIdentifier });
      if (orders.has(b.customIdentifier)) return reply(400, { errorCode: 'DUPLICATED_CUSTOM_IDENTIFIER', message: 'Already exists' });
      const tx = { transactionId: nextTx++, status: m === 'pending' ? 'PENDING' : 'SUCCESSFUL', customIdentifier: b.customIdentifier };
      orders.set(b.customIdentifier, tx);
      return reply(200, tx);
    }
    let m = u.pathname.match(/^\/orders\/transactions\/(\d+)\/cards$/);
    if (m) {
      calls.cards++;
      assert.equal(init.headers.Accept, 'application/com.reloadly.giftcards-v2+json');
      if (mode.cardsDown) return reply(404, { message: 'not yet' });
      return reply(200, [{ cardNumber: FAKE_CODE, pinCode: FAKE_PIN, redemptionUrl: 'https://example.com/redeem' }]);
    }
    if (u.pathname === '/reports/transactions') {
      const ci = u.searchParams.get('customIdentifier');
      return reply(200, { content: orders.has(ci) ? [orders.get(ci)] : [] });
    }
    m = u.pathname.match(/^\/reports\/transactions\/(\d+)$/);
    if (m) return reply(200, { transactionId: Number(m[1]), status: mode.txStatus || 'SUCCESSFUL' });
    return reply(404, { message: 'unexpected ' + u.pathname });
  }
  return { fetchFn, calls, orders };
}

const servers = [];
after(() => { for (const s of servers) s.close(); });

async function start(mode, extraCfg) {
  const fake = fakeReloadly(mode || {});
  const app = await createApp({
    memory: true,
    reloadlyFetch: fake.fetchFn,
    reloadlyTimeoutMs: 80,
    config: Object.assign({
      demoPartner: true,
      publicBaseUrl: 'http://127.0.0.1',
      secureCookies: false,
      adminPassword: 'test-admin',
      reloadlyClientId: 'test-id',
      reloadlyClientSecret: 'test-secret',
      reloadlyEnv: 'sandbox',
      giftCodeKey: 'test-gift-key'
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
  return { app, base, call, fake };
}

let userSeq = 0;
async function richUser(ctx, points) {
  const email = 'gift' + (++userSeq) + '@example.com';
  const su = await ctx.call('POST', '/api/auth/signup', { email, password: 'password12', agreeTerms: true, ageConfirm: true });
  assert.equal(su.status, 200, su.data);
  const db = ctx.app.locals.db;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  // partnerUsd * 0.7 share / 0.001 per point
  await ctx.app.locals.ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 'gift-pay-' + userSeq, offerId: 'dragon',
    source: 'offer', partnerUsd: points * 0.001 / 0.7, status: 'paid', sharePct: 0.7, pointUsd: 0.001
  });
  const headers = { cookie: 'goody_session=' + su.cookie };
  return { user, headers };
}

async function adminHeaders(ctx) {
  const a = await ctx.call('POST', '/admin/login', { password: 'test-admin' });
  assert.equal(a.status, 200, a.data);
  return { 'x-admin-token': a.data.token };
}

test('curated brands come from the catalog, with logos, values, and the Amazon $5 note', () => {
  const brands = payouts.curateBrands(CATALOG);
  assert.deepEqual(brands.map((b) => b.key), ['amazon', 'target', 'apple', 'roblox']);
  const amazon = brands.find((b) => b.key === 'amazon');
  assert.equal(amazon.min, 5);
  assert.deepEqual(amazon.values, [5, 10, 15, 20, 25, 50, 100]);
  assert.match(amazon.note, /\$5/);
  assert.equal(amazon.logo, 'https://cdn.reloadly.com/giftcards/amazon.png');
  const apple = brands.find((b) => b.key === 'apple');
  assert.equal(apple.type, 'FIXED');
  assert.deepEqual(apple.values, [2, 3, 10, 25]);
  assert.equal(apple.logo, 'https://cdn.reloadly.com/giftcards/apple.png');
  assert.equal(brands.find((b) => b.key === 'target').values[0], 1);

  assert.equal(payouts.validGiftValue(CATALOG[0], 5), true);
  assert.equal(payouts.validGiftValue(CATALOG[0], 4), false);
  assert.equal(payouts.validGiftValue(CATALOG[0], 101), false);
  assert.equal(payouts.validGiftValue(CATALOG[2], 10), true);
  assert.equal(payouts.validGiftValue(CATALOG[2], 11), false);
  assert.equal(payouts.validGiftValue(CATALOG[0], 5.555), false);
});

test('sandbox and live product names both match the curated list', () => {
  const names = (list) => payouts.curateBrands(list.map((n, i) => ({
    productId: i + 1, productName: n, status: 'ACTIVE', denominationType: 'RANGE', recipientCurrencyCode: 'USD',
    minRecipientDenomination: 1, maxRecipientDenomination: 100, logoUrls: ['https://cdn.reloadly.com/x.png']
  }))).map((b) => b.key + ':' + b.productName);
  assert.deepEqual(names([
    'Rewarble VISA Global US', 'Visa Prepaid US $1 to $150', 'Mastercard (Virtual) 1$ to $100 US',
    'App Store & iTunes US', 'Swype Global Virtual Mastercard® 3 years ($5 to $99.99) USD US'
  ]), ['visa:Visa Prepaid US $1 to $150', 'mastercard:Mastercard (Virtual) 1$ to $100 US', 'apple:App Store & iTunes US']);
  const live = payouts.curateBrands([{ productId: 9, productName: 'Mastercard® eReward Virtual Account, 6-Month Expiration [DOM] & [INTL] US',
    status: 'ACTIVE', denominationType: 'RANGE', recipientCurrencyCode: 'USD', minRecipientDenomination: 5, maxRecipientDenomination: 100, logoUrls: [] }]);
  assert.equal(live[0].key, 'mastercard');
  assert.match(live[0].note, /6 months/);
});

test('token is cached until it expires; catalog is cached for a few hours', async () => {
  const fake = fakeReloadly({});
  let now = 1_000_000;
  const client = payouts.createReloadly({ reloadlyClientId: 'test-id', reloadlyClientSecret: 'test-secret', reloadlyEnv: 'sandbox' }, { fetchFn: fake.fetchFn, now: () => now });
  assert.equal(client.base, SANDBOX);
  await client.brands();
  await client.brands();
  await client.getToken();
  assert.equal(fake.calls.auth, 1);
  assert.equal(fake.calls.products, 1);
  assert.deepEqual(fake.calls.audience, [SANDBOX]);
  now += 2 * 3600 * 1000; // token (1h) expired, catalog (3h) still fresh
  await client.brands();
  assert.equal(fake.calls.products, 1);
  await client.getToken();
  assert.equal(fake.calls.auth, 2);
  now += 2 * 3600 * 1000; // catalog now stale
  await client.brands();
  assert.equal(fake.calls.products, 2);
});

test('env picks the audience; a key/env mismatch is a clear error', async () => {
  assert.equal(payouts.reloadlyEnv({ reloadlyEnv: 'live' }), 'live');
  assert.equal(payouts.reloadlyEnv({ reloadlyEnv: 'production' }), 'live');
  assert.equal(payouts.reloadlyEnv({ reloadlyEnv: 'sandbox' }), 'sandbox');
  assert.equal(payouts.reloadlyEnv({ reloadlyEnv: 'whatever' }), 'sandbox');
  const fake = fakeReloadly({ liveOnly: true });
  const client = payouts.createReloadly({ reloadlyClientId: 'test-id', reloadlyClientSecret: 'test-secret', reloadlyEnv: 'sandbox' }, { fetchFn: fake.fetchFn });
  await assert.rejects(client.getToken(), (e) => e.kind === 'auth' && /do not match RELOADLY_ENV=sandbox/.test(e.message) && !/test-secret/.test(e.message));
  const live = payouts.createReloadly({ reloadlyClientId: 'test-id', reloadlyClientSecret: 'test-secret', reloadlyEnv: 'live' }, { fetchFn: fake.fetchFn });
  assert.equal(live.base, LIVE);
  assert.match(await live.getToken(), /^tok-/);
});

test('health shows reloadly on only with both keys', async () => {
  const on = await start({});
  assert.equal((await on.call('GET', '/api/health')).data.payouts.reloadly, true);
  const off = await start({}, { reloadlyClientId: '', reloadlyClientSecret: '' });
  if (!process.env.RELOADLY_CLIENT_ID) {
    assert.equal((await off.call('GET', '/api/health')).data.payouts.reloadly, false);
  }
});

test('gift card list for a signed-in user', async () => {
  const ctx = await start({});
  const { headers } = await richUser(ctx, 100);
  const r = await ctx.call('GET', '/api/giftcards', null, headers);
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.env, 'sandbox');
  assert.deepEqual(r.data.brands.map((b) => b.name), ['Amazon', 'Target', 'Apple', 'Roblox']);
  assert.equal((await ctx.call('GET', '/api/giftcards')).status, 401);

  const broken = await start({ liveOnly: true });
  const u2 = await richUser(broken, 100);
  const b = await broken.call('GET', '/api/giftcards', null, u2.headers);
  assert.equal(b.data.enabled, false);
});

test('cash out checks the card, the amount, and the points on the server', async () => {
  const ctx = await start({});
  const { headers } = await richUser(ctx, 6000);
  const bad = async (body, re) => {
    const r = await ctx.call('POST', '/api/cashout', Object.assign({ method: 'gift' }, body), headers);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad({ productId: 777, value: 10 }, /Pick a card/);       // not on our list
  await bad({ productId: 18285, value: 10 }, /Pick a card/);     // inactive
  await bad({ productId: 5, value: 4 }, /amounts shown/);        // Amazon starts at $5
  await bad({ productId: 5, value: 7 }, /amounts shown/);        // not one of our steps
  await bad({ productId: 21, value: 11 }, /amounts shown/);      // not a fixed value
  await bad({ productId: 5, value: 10 }, /need 10000 points/);   // can't afford
  const ok = await ctx.call('POST', '/api/cashout', { method: 'gift', productId: 5, value: 5 }, headers);
  assert.equal(ok.status, 200, ok.data);
  assert.equal(ok.data.cashout.status, 'requested');
  assert.equal(ok.data.cashout.points, 5000);
  assert.equal(ok.data.cashout.destination, 'Amazon $5');
  assert.equal(ok.data.cashout.gift_brand, 'Amazon');
  assert.equal(ok.data.balance.held, 5000);
  assert.equal(ctx.fake.calls.orders.length, 0, 'no order before the admin approves');
});

test('admin approve buys the card once, saves the code locked, and shows it only to the owner', async () => {
  const ctx = await start({});
  const { user, headers } = await richUser(ctx, 6000);
  const co = await ctx.call('POST', '/api/cashout', { method: 'gift', productId: 21, value: 3 }, headers);
  assert.equal(co.status, 200, co.data);
  const id = co.data.cashout.id;
  const admin = await adminHeaders(ctx);
  const ap = await ctx.call('POST', '/admin/api/cashouts/' + id + '/approve', {}, admin);
  assert.equal(ap.status, 200, ap.data);
  assert.equal(ap.data.cashout.status, 'sent');
  assert.equal(ap.data.cashout.payout_provider, 'reloadly');
  assert.equal(ap.data.cashout.has_code, true);
  assert.equal(ap.data.cashout.gift_code_enc, undefined);
  assert.doesNotMatch(JSON.stringify(ap.data), new RegExp(FAKE_CODE));

  const order = ctx.fake.calls.orders[0];
  assert.deepEqual(
    { productId: order.productId, unitPrice: order.unitPrice, countryCode: order.countryCode, quantity: order.quantity, customIdentifier: order.customIdentifier },
    { productId: 21, unitPrice: 3, countryCode: 'US', quantity: 1, customIdentifier: 'goody-cashout-' + id }
  );

  // Stored locked, never as plain text.
  const row = await ctx.app.locals.db.get('SELECT * FROM cashouts WHERE id = ?', [id]);
  assert.ok(row.gift_code_enc.startsWith('v1:'));
  assert.doesNotMatch(row.gift_code_enc, new RegExp(FAKE_CODE));
  assert.match(secretBox.open(row.gift_code_enc, 'test-gift-key'), new RegExp(FAKE_CODE));

  // Lists never include the code.
  const list = await ctx.call('GET', '/api/cashouts', null, headers);
  assert.doesNotMatch(JSON.stringify(list.data), new RegExp(FAKE_CODE + '|v1:'));
  const adminList = await ctx.call('GET', '/admin/api/cashouts', null, admin);
  assert.doesNotMatch(JSON.stringify(adminList.data), new RegExp(FAKE_CODE + '|v1:'));

  // Owner sees it; someone else does not.
  const code = await ctx.call('GET', '/api/cashouts/' + id + '/code', null, headers);
  assert.equal(code.status, 200);
  assert.equal(code.data.ready, true);
  assert.equal(code.data.cards[0].cardNumber, FAKE_CODE);
  assert.equal(code.data.cards[0].pinCode, FAKE_PIN);
  const other = await richUser(ctx, 10);
  assert.equal((await ctx.call('GET', '/api/cashouts/' + id + '/code', null, other.headers)).status, 404);

  // Points are spent, not held.
  const bal = await ctx.app.locals.ledger.balanceOf(ctx.app.locals.db, user.id);
  assert.equal(bal.held, 0);
  assert.equal(bal.paidOut, 3000);

  // Approving again does nothing.
  const again = await ctx.call('POST', '/admin/api/cashouts/' + id + '/approve', {}, admin);
  assert.equal(again.status, 400);
  assert.equal(ctx.fake.calls.orders.length, 1);
});

test('a clear "no" from Reloadly gives the points back', async () => {
  for (const mode of ['reject', 'failed']) {
    const ctx = await start({ order: mode });
    const { user, headers } = await richUser(ctx, 6000);
    const co = await ctx.call('POST', '/api/cashout', { method: 'gift', productId: 5, value: 5 }, headers);
    const ap = await ctx.call('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/approve', {}, await adminHeaders(ctx));
    assert.equal(ap.status, 200, ap.data);
    assert.equal(ap.data.cashout.status, 'failed', mode);
    assert.match(ap.data.cashout.admin_note, /points came back/);
    const bal = await ctx.app.locals.ledger.balanceOf(ctx.app.locals.db, user.id);
    assert.equal(bal.available, 6000, mode);
    assert.equal(bal.held, 0);
  }
});

test('a timeout or empty wallet keeps the points held and can be approved again safely', async () => {
  for (const mode of ['hang', 'balance']) {
    const fakeMode = { order: mode };
    const ctx = await start(fakeMode);
    const { user, headers } = await richUser(ctx, 6000);
    const co = await ctx.call('POST', '/api/cashout', { method: 'gift', productId: 5, value: 5 }, headers);
    const id = co.data.cashout.id;
    const admin = await adminHeaders(ctx);
    const ap = await ctx.call('POST', '/admin/api/cashouts/' + id + '/approve', {}, admin);
    assert.equal(ap.status, 200, ap.data);
    assert.equal(ap.data.cashout.status, 'requested', mode);
    assert.ok(ap.data.cashout.payout_error, mode);
    if (mode === 'hang') assert.match(ap.data.cashout.payout_error, /too long/);
    if (mode === 'balance') assert.match(ap.data.cashout.payout_error, /wallet needs more money/);
    const bal = await ctx.app.locals.ledger.balanceOf(ctx.app.locals.db, user.id);
    assert.equal(bal.held, 5000, mode);

    // The problem is fixed (wallet funded / Reloadly answers): Approve again works.
    fakeMode.order = 'ok';
    const again = await ctx.call('POST', '/admin/api/cashouts/' + id + '/approve', {}, admin);
    assert.equal(again.data.cashout.status, 'sent', mode);
    assert.equal(ctx.fake.orders.size, 1);
    const ids = new Set(ctx.fake.calls.orders.map((o) => o.customIdentifier));
    assert.deepEqual([...ids], ['goody-cashout-' + id]);
  }
});

test('a retry after a lost answer reuses the first order instead of buying twice', async () => {
  const fake = fakeReloadly({});
  const client = payouts.createReloadly({ reloadlyClientId: 'test-id', reloadlyClientSecret: 'test-secret' }, { fetchFn: fake.fetchFn });
  const a = await client.placeOrder({ productId: 5, unitPrice: 5, customIdentifier: 'goody-cashout-42' });
  const b = await client.placeOrder({ productId: 5, unitPrice: 5, customIdentifier: 'goody-cashout-42' });
  assert.equal(b.transactionId, a.transactionId);
  assert.equal(b.reused, true);
  assert.equal(fake.orders.size, 1);
});

test('a pending order shows the code later when it is ready', async () => {
  const ctx = await start({ order: 'pending' });
  const { headers } = await richUser(ctx, 6000);
  const co = await ctx.call('POST', '/api/cashout', { method: 'gift', productId: 12740, value: 1 }, headers);
  const ap = await ctx.call('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/approve', {}, await adminHeaders(ctx));
  assert.equal(ap.data.cashout.status, 'sent');
  assert.equal(ap.data.cashout.has_code, false);
  const code = await ctx.call('GET', '/api/cashouts/' + co.data.cashout.id + '/code', null, headers);
  assert.equal(code.data.ready, true);
  assert.equal(code.data.cards[0].pinCode, FAKE_PIN);
});

test('if Reloadly later says the order failed, the points come back', async () => {
  const ctx = await start({ order: 'pending', cardsDown: true, txStatus: 'REFUNDED' });
  const { user, headers } = await richUser(ctx, 6000);
  const co = await ctx.call('POST', '/api/cashout', { method: 'gift', productId: 12740, value: 2 }, headers);
  await ctx.call('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/approve', {}, await adminHeaders(ctx));
  const code = await ctx.call('GET', '/api/cashouts/' + co.data.cashout.id + '/code', null, headers);
  assert.equal(code.data.ready, false);
  assert.equal(code.data.failed, true);
  const bal = await ctx.app.locals.ledger.balanceOf(ctx.app.locals.db, user.id);
  assert.equal(bal.available, 6000);
});

test('old email-style gift requests still go to manual approval', async () => {
  const ctx = await start({});
  const { headers } = await richUser(ctx, 6000);
  const co = await ctx.call('POST', '/api/cashout', { method: 'gift', destination: 'kid@example.com', points: 3000 }, headers);
  assert.equal(co.status, 200, co.data);
  const ap = await ctx.call('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/approve', {}, await adminHeaders(ctx));
  assert.equal(ap.data.cashout.status, 'approved');
  assert.equal(ap.data.cashout.payout_mode, 'manual');
  assert.equal(ctx.fake.calls.orders.length, 0);
});
