'use strict';

const { creditFromPartner, money, isoNow } = require('./money');

function holdDurationMs(holdDays) {
  const d = Number(holdDays);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.round(d * 24 * 60 * 60 * 1000);
}

/** When a credit becomes cash-out-able. Null means it is available as soon as it is paid. */
function creditAvailableAt(holdDays, now) {
  const ms = holdDurationMs(holdDays);
  if (ms <= 0) return null;
  return new Date(new Date(now).getTime() + ms).toISOString();
}

/**
 * Turn held credits into paid once their available_at time has passed.
 * Credits with no available_at stay pending (partner still checking).
 */
async function releaseDue(db, userId, nowIso) {
  const now = nowIso || isoNow();
  if (userId != null) {
    await db.run(
      `UPDATE ledger SET status = 'paid', updated_at = ?
       WHERE user_id = ? AND entry_type = 'credit' AND status = 'pending'
         AND available_at IS NOT NULL AND available_at <= ?`,
      [now, userId, now]
    );
  } else {
    await db.run(
      `UPDATE ledger SET status = 'paid', updated_at = ?
       WHERE entry_type = 'credit' AND status = 'pending'
         AND available_at IS NOT NULL AND available_at <= ?`,
      [now, now]
    );
  }
}

async function balanceOf(db, userId) {
  await releaseDue(db, userId);
  const row = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='paid' THEN points ELSE 0 END), 0) AS paid_in,
       COALESCE(SUM(CASE WHEN entry_type='debit' AND status='paid' THEN points ELSE 0 END), 0) AS paid_out,
       COALESCE(SUM(CASE WHEN entry_type='debit' AND status='pending' THEN points ELSE 0 END), 0) AS held,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='pending' THEN points ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='pending' AND available_at IS NULL THEN points ELSE 0 END), 0) AS checking,
       MIN(CASE WHEN entry_type='credit' AND status='pending' AND available_at IS NOT NULL THEN available_at END) AS next_release_at,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='paid' THEN partner_usd ELSE 0 END), 0) AS partner_usd,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='paid' THEN user_usd ELSE 0 END), 0) AS user_usd
     FROM ledger WHERE user_id = ?`,
    [userId]
  ) || {};
  const paidIn = Number(row.paid_in) || 0;
  const paidOut = Number(row.paid_out) || 0;
  const held = Number(row.held) || 0;
  const pending = Number(row.pending) || 0;
  const checking = Number(row.checking) || 0;
  const nextReleaseAt = row.next_release_at || null;
  let nextReleasePoints = 0;
  if (nextReleaseAt) {
    const n = await db.get(
      `SELECT COALESCE(SUM(points), 0) AS pts FROM ledger
       WHERE user_id = ? AND entry_type = 'credit' AND status = 'pending' AND available_at = ?`,
      [userId, nextReleaseAt]
    );
    nextReleasePoints = Number(n && n.pts) || 0;
  }
  return {
    available: paidIn - paidOut - held,
    pending,
    checking,
    nextReleaseAt,
    nextReleasePoints,
    paidIn,
    paidOut,
    held,
    partnerUsd: money(row.partner_usd || 0),
    userUsd: money(row.user_usd || 0)
  };
}

async function findByTx(db, partner, txId) {
  if (!partner || !txId) return undefined;
  return await db.get('SELECT * FROM ledger WHERE partner = ? AND tx_id = ?', [partner, txId]);
}

/**
 * Apply a partner postback to the ledger.
 * status: 'pending' | 'paid' | 'rejected' | 'reversal'
 * Idempotent on (partner, tx_id) for the same outcome.
 */
async function applyPostback(db, { userId, partner, txId, offerId, source, partnerUsd, status, note, sharePct, pointUsd, holdDays }) {
  if (!userId) throw Object.assign(new Error('unknown user'), { code: 'NO_USER', http: 400 });
  if (!partner || !txId) throw Object.assign(new Error('missing transaction'), { code: 'NO_TX', http: 400 });

  const now = isoNow();
  const existing = await findByTx(db, partner, txId);
  const isReversal = status === 'reversal' || status === 'rejected' || status === 'chargeback';

  if (isReversal) {
    if (!existing) {
      // Record a rejected placeholder so a later "paid" with same tx is ignored? Better to
      // insert a rejected credit so a delayed paid postback can be recognized and refused.
      const parts = creditFromPartner(partnerUsd || 0, sharePct, pointUsd);
      await db.run(
        `INSERT INTO ledger (user_id, entry_type, status, source, partner, offer_id, tx_id, partner_usd, user_usd, points, note, available_at, created_at, updated_at)
         VALUES (?, 'credit', 'rejected', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [userId, source || 'offer', partner, offerId || null, txId, parts.partnerUsd, parts.userUsd, parts.points, note || 'reversal (no prior credit)', now, now]
      );
      return { action: 'logged-reversal', entry: await findByTx(db, partner, txId), idempotent: false };
    }
    if (existing.status === 'rejected') {
      return { action: 'already-rejected', entry: existing, idempotent: true };
    }
    await db.run('UPDATE ledger SET status = ?, note = ?, updated_at = ? WHERE id = ?', [
      'rejected',
      note || existing.note || 'reversed by partner',
      now,
      existing.id
    ]);
    return { action: 'reversed', entry: await findByTx(db, partner, txId), idempotent: false };
  }

  const want = status === 'pending' ? 'pending' : 'paid';
  const parts = creditFromPartner(partnerUsd, sharePct, pointUsd);
  // Partner "paid" credits stay pending until the hold is over. holdDays 0 (or omitted) pays immediately.
  const releaseAt = want === 'paid' ? creditAvailableAt(holdDays, now) : null;
  const stored = want === 'paid' && releaseAt ? 'pending' : want;

  if (existing) {
    if (existing.status === 'rejected') {
      // Do not revive a reversed transaction via a replayed "paid"
      return { action: 'ignored-after-reversal', entry: existing, idempotent: true };
    }
    // Already paid, or already on hold for this tx (pending with a release time).
    if (existing.status === 'paid' && want === 'paid') {
      return { action: 'duplicate', entry: existing, idempotent: true };
    }
    if (existing.status === 'pending' && existing.available_at && want === 'paid') {
      return { action: 'duplicate', entry: existing, idempotent: true };
    }
    if (existing.status === want) {
      return { action: 'duplicate', entry: existing, idempotent: true };
    }
    if (existing.status === 'pending' && want === 'paid') {
      await db.run(
        'UPDATE ledger SET status = ?, partner_usd = ?, user_usd = ?, points = ?, note = ?, available_at = ?, updated_at = ? WHERE id = ?',
        [stored, parts.partnerUsd, parts.userUsd, parts.points, note || existing.note, releaseAt, now, existing.id]
      );
      const action = stored === 'paid' ? 'settled' : 'held';
      return { action, entry: await findByTx(db, partner, txId), idempotent: false };
    }
    // paid then pending? ignore
    return { action: 'duplicate', entry: existing, idempotent: true };
  }

  await db.run(
    `INSERT INTO ledger (user_id, entry_type, status, source, partner, offer_id, tx_id, partner_usd, user_usd, points, note, available_at, created_at, updated_at)
     VALUES (?, 'credit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, stored, source || 'offer', partner, offerId || null, txId, parts.partnerUsd, parts.userUsd, parts.points, note || null, releaseAt, now, now]
  );
  const action = want === 'pending' ? 'pending' : (stored === 'pending' ? 'held' : 'paid');
  return { action, entry: await findByTx(db, partner, txId), idempotent: false };
}

async function holdDebit(db, { userId, source, points, usd, note }) {
  const now = isoNow();
  const r = await db.run(
    `INSERT INTO ledger (user_id, entry_type, status, source, partner, offer_id, tx_id, partner_usd, user_usd, points, note, created_at, updated_at)
     VALUES (?, 'debit', 'pending', ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?)`,
    [userId, source || 'cashout', money(usd || 0), points, note || null, now, now]
  );
  return await db.get('SELECT * FROM ledger WHERE id = ?', [r.lastInsertRowid]);
}

async function settleDebit(db, ledgerId, status) {
  const now = isoNow();
  await db.run('UPDATE ledger SET status = ?, updated_at = ? WHERE id = ? AND entry_type = ?', [
    status, now, ledgerId, 'debit'
  ]);
  return await db.get('SELECT * FROM ledger WHERE id = ?', [ledgerId]);
}

async function history(db, userId, status) {
  await releaseDue(db, userId);
  if (status && status !== 'all') {
    return await db.all(
      `SELECT * FROM ledger WHERE user_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
      [userId, status]
    );
  }
  return await db.all(
    `SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    [userId]
  );
}

module.exports = { balanceOf, findByTx, applyPostback, holdDebit, settleDebit, history, releaseDue, creditAvailableAt, holdDurationMs };
