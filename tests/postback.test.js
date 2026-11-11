'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server/app');
const { signGeneric, hmac, md5 } = require('../server/lib/postback');

const SECRET = 'test-demo-secret';
const BITLABS_SECRET = 'JLOIAUNMHFli7ZJOQVEzm98rzqnm9';
const CPX_SECRET = 'cpx-test-hash';
const ADGEM_SECRET = 'adgem-postback-key';

let app, server, base, token, publicId;

function listen(a) {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function json(method, url, body, headers) {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

before(async () => {
  app = await createApp({
    memory: true,
    config: {
      demoPartner: true,
      demoPendingMs: 0,
      demoPaidMs: 0,
      demoRejectRate: 0,
      sharePct: 0.7,
      pointUsd: 0.001,
      firstCashoutUsd: 0.5,
      publicBaseUrl: 'http://127.0.0.1',
      adminPassword: 'test-admin',
      partners: {
        demo: { name: 'Demo', secret: SECRET, style: 'generic', enabled: true },
        bitlabs: { name: 'BitLabs', secret: BITLABS_SECRET, style: 'bitlabs', enabled: true },
        cpx: { name: 'CPX', secret: CPX_SECRET, style: 'cpx', enabled: true },
        adgem: { name: 'AdGem', secret: ADGEM_SECRET, style: 'adgem', enabled: true }
      }
    }
  });
  // publicBaseUrl is fixed after listen — we'll patch after we know the port for BitLabs
  server = await listen(app);
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  app.locals.config.publicBaseUrl = base;

  const ses = await json('POST', '/api/session', { deviceId: 'device-postback-test-001' });
  assert.equal(ses.status, 200);
  token = ses.data.token;
  publicId = ses.data.publicId;
});

after(async () => {
  if (app && app.close) app.close();
  if (server) await new Promise((r) => server.close(r));
});

function auth() { return { authorization: 'Bearer ' + token }; }

test('signed demo postback credits the user share only', async () => {
  const payout = 1.2;
  const txid = 'pb-paid-1';
  const status = 'paid';
  const sig = signGeneric({ uid: publicId, txid, payout, status }, SECRET);
  const q = new URLSearchParams({ uid: publicId, txid, payout, status, offer_id: 'dragon', source: 'offer', sig });
  const res = await json('GET', '/postback/demo?' + q.toString());
  assert.equal(res.status, 200, res.data);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.action, 'paid');
  const me = await json('GET', '/api/me', null, auth());
  // 1.2 * 0.7 = 0.84 = 840 pts
  assert.equal(me.data.balance.available, 840);
});

test('missing or bad signature is rejected', async () => {
  const q = new URLSearchParams({ uid: publicId, txid: 'pb-bad', payout: 1, status: 'paid', sig: 'deadbeef' });
  const res = await json('GET', '/postback/demo?' + q.toString());
  assert.equal(res.status, 403);
  const none = await json('GET', '/postback/demo?uid=' + publicId + '&txid=x&payout=1&status=paid');
  assert.equal(none.status, 403);
});

test('idempotent replay does not pay twice', async () => {
  const payout = 1.2;
  const txid = 'pb-paid-1';
  const status = 'paid';
  const sig = signGeneric({ uid: publicId, txid, payout, status }, SECRET);
  const q = new URLSearchParams({ uid: publicId, txid, payout, status, offer_id: 'dragon', source: 'offer', sig });
  const res = await json('GET', '/postback/demo?' + q.toString());
  assert.equal(res.status, 200);
  assert.equal(res.data.idempotent, true);
  const me = await json('GET', '/api/me', null, auth());
  assert.equal(me.data.balance.available, 840);
});

test('pending then paid, then reversal removes the points', async () => {
  const payout = 1.0;
  const txid = 'pb-rev-1';
  const pend = signGeneric({ uid: publicId, txid, payout, status: 'pending' }, SECRET);
  const q1 = new URLSearchParams({ uid: publicId, txid, payout, status: 'pending', offer_id: 'puzzle', source: 'offer', sig: pend });
  const r1 = await json('GET', '/postback/demo?' + q1.toString());
  assert.equal(r1.status, 200);
  assert.equal(r1.data.action, 'pending');
  let me = await json('GET', '/api/me', null, auth());
  assert.equal(me.data.balance.available, 840);
  assert.ok(me.data.balance.pending > 0);

  const pay = signGeneric({ uid: publicId, txid, payout, status: 'paid' }, SECRET);
  const q2 = new URLSearchParams({ uid: publicId, txid, payout, status: 'paid', offer_id: 'puzzle', source: 'offer', sig: pay });
  const r2 = await json('GET', '/postback/demo?' + q2.toString());
  assert.equal(r2.data.action, 'settled');
  me = await json('GET', '/api/me', null, auth());
  assert.equal(me.data.balance.available, 840 + 700);

  const rev = signGeneric({ uid: publicId, txid, payout, status: 'reversal' }, SECRET);
  const q3 = new URLSearchParams({ uid: publicId, txid, payout, status: 'reversal', offer_id: 'puzzle', source: 'offer', sig: rev });
  const r3 = await json('GET', '/postback/demo?' + q3.toString());
  assert.equal(r3.status, 200);
  assert.equal(r3.data.action, 'reversed');
  me = await json('GET', '/api/me', null, auth());
  assert.equal(me.data.balance.available, 840);
});

test('BitLabs HMAC-SHA1 of the URL (public docs) is accepted', async () => {
  const pathQ = `/postback/bitlabs?uid=${publicId}&tx=bl-1&raw=0.8&val=560&type=COMPLETE&offer_id=survey1`;
  const url = base + pathQ;
  const hash = hmac('sha1', BITLABS_SECRET, url, 'hex');
  const res = await json('GET', pathQ + '&hash=' + hash);
  assert.equal(res.status, 200, res.data);
  assert.equal(res.data.ok, true);
  const me = await json('GET', '/api/me', null, auth());
  // 0.8 * 0.7 = 0.56 = 560 pts
  assert.equal(me.data.balance.available, 840 + 560);
});

test('CPX md5(trans_id + "-" + secret) and status 2 reversal', async () => {
  const trans_id = 'cpx-99';
  const hash = md5(trans_id + '-' + CPX_SECRET);
  const q = new URLSearchParams({
    user_id: publicId, trans_id, amount_usd: '0.5', amount_local: '350', status: '1',
    offer_ID: 'snacks', secure_hash: hash, source: 'survey'
  });
  const res = await json('GET', '/postback/cpx?' + q.toString());
  assert.equal(res.status, 200, res.data);
  let me = await json('GET', '/api/me', null, auth());
  const afterPay = me.data.balance.available;
  assert.equal(afterPay, 840 + 560 + 350);

  const hash2 = md5(trans_id + '-' + CPX_SECRET);
  const q2 = new URLSearchParams({
    user_id: publicId, trans_id, amount_usd: '0.5', amount_local: '350', status: '2',
    offer_ID: 'snacks', secure_hash: hash2, source: 'survey'
  });
  const res2 = await json('GET', '/postback/cpx?' + q2.toString());
  assert.equal(res2.status, 200);
  assert.equal(res2.data.action, 'reversed');
  me = await json('GET', '/api/me', null, auth());
  assert.equal(me.data.balance.available, 840 + 560);
});

test('AdGem v3 Signature header over the raw body', async () => {
  const body = {
    request_id: 'ag-req-1',
    timestamp: Date.now(),
    data: {
      player_id: publicId,
      transaction_id: 'ag-tx-1',
      payout: 0.4,
      campaign_id: 'newsly'
    }
  };
  const raw = JSON.stringify(body);
  const sig = hmac('sha256', ADGEM_SECRET, raw, 'hex');
  const res = await fetch(base + '/postback/adgem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Signature: sig },
    body: raw
  });
  const data = await res.json();
  assert.equal(res.status, 200, data);
  assert.equal(data.ok, true);
  const me = await json('GET', '/api/me', null, auth());
  // 0.4 * 0.7 = 0.28 = 280 pts
  assert.equal(me.data.balance.available, 840 + 560 + 280);
});

test('first cash-out minimum is $0.50 and is checked on the server', async () => {
  // available should be 1680; first min is 500 pts
  const tooSmall = await json('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 100 }, auth());
  assert.equal(tooSmall.status, 400);
  assert.match(String(tooSmall.data.error), /first cash out|500/i);

  const ok = await json('POST', '/api/cashout', { method: 'lightning', destination: 'me@wallet.com', points: 500 }, auth());
  assert.equal(ok.status, 200, ok.data);
  assert.equal(ok.data.cashout.status, 'requested');
  assert.equal(ok.data.cashout.is_first, 1);
  const me = await json('GET', '/api/me', null, auth());
  assert.equal(me.data.firstCashoutDone, true);
  // 500 pts held
  assert.equal(me.data.balance.held, 500);
});
