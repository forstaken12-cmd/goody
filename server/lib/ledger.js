'use strict';

const { creditFromPartner, money, isoNow } = require('./money');

async function balanceOf(db, userId) {
  const row = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='paid' THEN points ELSE 0 END), 0) AS paid_in,
       COALESCE(SUM(CASE WHEN entry_type='debit' AND status='paid' THEN points ELSE 0 END), 0) AS paid_out,
       COALESCE(SUM(CASE WHEN entry_type='debit' AND status='pending' THEN points ELSE 0 END), 0) AS held,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='pending' THEN points ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='paid' THEN partner_usd ELSE 0 END), 0) AS partner_usd,
       COALESCE(SUM(CASE WHEN entry_type='credit' AND status='paid' THEN user_usd ELSE 0 END), 0) AS user_usd
     FROM ledger WHERE user_id = ?`,
    [userId]
  ) || {};
  const paidIn = Number(row.paid_in) || 0;
  const paidOut = Number(row.paid_out) || 0;
  const held = Number(row.held) || 0;
  const pending = Number(row.pending) || 0;
  return {
    available: paidIn - paidOut - held,
    pending,
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
async function applyPostback(db, { userId, partner, txId, offerId, source, partnerUsd, status, note, sharePct, pointUsd }) {
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
        `INSERT INTO ledger (user_id, entry_type, status, source, partner, offer_id, tx_id, partner_usd, user_usd, points, note, created_at, updated_at)
         VALUES (?, 'credit', 'rejected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  if (existing) {
    if (existing.status === 'rejected') {
      // Do not revive a reversed transaction via a replayed "paid"
      return { action: 'ignored-after-reversal', entry: existing, idempotent: true };
    }
    if (existing.status === want) {
      return { action: 'duplicate', entry: existing, idempotent: true };
    }
    if (existing.status === 'pending' && want === 'paid') {
      await db.run(
        'UPDATE ledger SET status = ?, partner_usd = ?, user_usd = ?, points = ?, note = ?, updated_at = ? WHERE id = ?',
        [want, parts.partnerUsd, parts.userUsd, parts.points, note || existing.note, now, existing.id]
      );
      return { action: 'settled', entry: await findByTx(db, partner, txId), idempotent: false };
    }
    // paid then pending? ignore
    return { action: 'duplicate', entry: existing, idempotent: true };
  }

  await db.run(
    `INSERT INTO ledger (user_id, entry_type, status, source, partner, offer_id, tx_id, partner_usd, user_usd, points, note, created_at, updated_at)
     VALUES (?, 'credit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, want, source || 'offer', partner, offerId || null, txId, parts.partnerUsd, parts.userUsd, parts.points, note || null, now, now]
  );
  return { action: want === 'pending' ? 'pending' : 'paid', entry: await findByTx(db, partner, txId), idempotent: false };
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

module.exports = { balanceOf, findByTx, applyPostback, holdDebit, settleDebit, history };
