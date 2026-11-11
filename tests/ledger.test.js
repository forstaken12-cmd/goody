'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const ledger = require('../server/lib/ledger');
const { signup } = require('../server/lib/auth');

const SHARE = 0.7;
const PV = 0.001;
let db, user;

before(async () => {
  db = await openDb({ memory: true });
  const r = await signup(db, {
    email: 'ledger@example.com',
    password: 'password12',
    agreeTerms: true,
    ageConfirm: true
  }, {});
  user = r.user;
});

after(async () => {
  if (db && db.close) await db.close();
});

test('balance starts at zero', async () => {
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
  assert.equal(b.pending, 0);
});

test('pending credit does not add to available balance', async () => {
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 't-pending-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1.0, status: 'pending', sharePct: SHARE, pointUsd: PV
  });
  assert.equal(r.action, 'pending');
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
  assert.ok(b.pending > 0);
  assert.equal(b.pending, r.entry.points);
});

test('settling a pending credit adds points (70% of partner USD)', async () => {
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 't-pending-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1.0, status: 'paid', sharePct: SHARE, pointUsd: PV
  });
  assert.equal(r.action, 'settled');
  assert.equal(r.entry.points, 700);
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 700);
  assert.equal(b.pending, 0);
  assert.equal(b.partnerUsd, 1);
});

test('idempotent paid postback does not double-credit', async () => {
  const before = await ledger.balanceOf(db, user.id);
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 't-pending-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1.0, status: 'paid', sharePct: SHARE, pointUsd: PV
  });
  assert.equal(r.idempotent, true);
  const after = await ledger.balanceOf(db, user.id);
  assert.equal(after.available, before.available);
  assert.equal(after.paidIn, before.paidIn);
});

test('reversal of a paid credit removes it from the balance', async () => {
  const r = await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 't-pending-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1.0, status: 'reversal', sharePct: SHARE, pointUsd: PV
  });
  assert.equal(r.action, 'reversed');
  assert.equal(r.entry.status, 'rejected');
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
});

test('a later paid postback cannot revive a reversed transaction', async () => {
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 't-pending-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 1.0, status: 'paid', sharePct: SHARE, pointUsd: PV
  });
  const b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 0);
});

test('held cash-out debit reduces available points until rejected', async () => {
  await ledger.applyPostback(db, {
    userId: user.id, partner: 'demo', txId: 't-cash-src', offerId: 'x',
    source: 'offer', partnerUsd: 2.0, status: 'paid', sharePct: SHARE, pointUsd: PV
  });
  let b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 1400);
  const debit = await ledger.holdDebit(db, { userId: user.id, source: 'cashout', points: 500, usd: 0.5, note: 'test' });
  b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 900);
  assert.equal(b.held, 500);
  await ledger.settleDebit(db, debit.id, 'rejected');
  b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 1400);
  assert.equal(b.held, 0);
  const debit2 = await ledger.holdDebit(db, { userId: user.id, source: 'cashout', points: 500, usd: 0.5 });
  await ledger.settleDebit(db, debit2.id, 'paid');
  b = await ledger.balanceOf(db, user.id);
  assert.equal(b.available, 900);
  assert.equal(b.paidOut, 500);
});
