'use strict';

const crypto = require('crypto');
const { signGeneric } = require('../lib/postback');
const { findOffer } = require('./catalog');

function makeTx(prefix) {
  return prefix + '-' + crypto.randomBytes(6).toString('hex');
}

function createSimulator({ config, ingest, db }) {
  const secret = config.partners.demo.secret;
  const timers = new Set();

  function later(ms, fn) {
    if (!ms || ms <= 0) {
      fn();
      return { unref() {} };
    }
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    if (t.unref) t.unref();
    return t;
  }

  function fire({ uid, txid, payout, status, offerId, source, note }) {
    const sig = signGeneric({ uid, txid, payout, status }, secret);
    return ingest({
      partnerKey: 'demo',
      query: {
        uid, txid, payout, status,
        offer_id: offerId,
        source: source || 'offer',
        sig,
        note
      }
    });
  }

  function scheduleSettlement({ uid, txid, payout, offerId, source, outcome, note }) {
    const pendingMs = config.demoPendingMs;
    const paidMs = config.demoPaidMs;
    later(pendingMs, () => {
      fire({ uid, txid, payout, status: 'pending', offerId, source, note });
      later(paidMs, () => {
        const status = outcome === 'rejected' ? 'reversal' : 'paid';
        fire({ uid, txid, payout, status, offerId, source, note });
      });
    });
  }

  function startInstall(user, offer, { outcome } = {}) {
    if (!offer) throw Object.assign(new Error('Unknown offer'), { http: 404 });
    const uid = user.public_id;
    const txid = makeTx(offer.id);
    let result = outcome;
    if (!result) {
      result = Math.random() < config.demoRejectRate ? 'rejected' : 'paid';
    }
    db.run(
      `INSERT INTO offer_progress (user_id, offer_id, started_at, minutes_played, steps_done, status)
       VALUES (?, ?, datetime('now'), 0, 0, 'running')
       ON CONFLICT(user_id, offer_id) DO UPDATE SET started_at = excluded.started_at, status = 'running'`,
      [user.id, offer.id]
    );
    scheduleSettlement({
      uid, txid, payout: offer.partnerUsd, offerId: offer.id,
      source: offer.type === 'survey' ? 'survey' : 'offer',
      outcome: result,
      note: offer.name
    });
    return { txid, outcome: result };
  }

  function play(user, offer, addMinutes) {
    if (!offer || offer.type !== 'playtime') {
      throw Object.assign(new Error('That is not a playtime offer'), { http: 400 });
    }
    let prog = db.get('SELECT * FROM offer_progress WHERE user_id = ? AND offer_id = ?', [user.id, offer.id]);
    if (!prog) {
      db.run(
        `INSERT INTO offer_progress (user_id, offer_id, started_at, minutes_played, steps_done, status)
         VALUES (?, ?, datetime('now'), 0, 0, 'running')`,
        [user.id, offer.id]
      );
      prog = db.get('SELECT * FROM offer_progress WHERE user_id = ? AND offer_id = ?', [user.id, offer.id]);
    }
    const before = prog.minutes_played || 0;
    const after = before + Math.max(0, Number(addMinutes) || 0);
    db.run('UPDATE offer_progress SET minutes_played = ?, status = ? WHERE user_id = ? AND offer_id = ?', [
      after, 'running', user.id, offer.id
    ]);
    const fired = [];
    for (const m of offer.milestones || []) {
      if (before < m.minutes && after >= m.minutes) {
        const txid = `${offer.id}:${m.id}:${user.public_id}`;
        scheduleSettlement({
          uid: user.public_id,
          txid,
          payout: m.partnerUsd,
          offerId: offer.id,
          source: 'playtime',
          outcome: 'paid',
          note: `${offer.name} · ${m.minutes} min`
        });
        fired.push({ milestone: m.id, minutes: m.minutes, txid });
      }
    }
    const last = offer.milestones && offer.milestones[offer.milestones.length - 1];
    if (last && after >= last.minutes) {
      db.run('UPDATE offer_progress SET status = ? WHERE user_id = ? AND offer_id = ?', [
        'done', user.id, offer.id
      ]);
    }
    return { minutes: after, fired };
  }

  function bonus({ kind, user, day, tx }) {
    const amounts = { daily: 0.1, streak: day === 7 ? 0.3 : 0.15, goals: 0.12 };
    const payout = amounts[kind] || 0.1;
    const txid = tx || `${kind}-${day || 'x'}-${user.public_id}-${Date.now()}`;
    const notes = {
      daily: 'Daily check-in gift',
      streak: 'Streak bonus · day ' + day,
      goals: 'Daily goals bonus'
    };
    scheduleSettlement({
      uid: user.public_id,
      txid,
      payout,
      offerId: kind,
      source: kind === 'daily' ? 'daily' : kind === 'streak' ? 'streak' : 'goal',
      outcome: 'paid',
      note: notes[kind] || kind
    });
    return { txid, payout };
  }

  function close() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return { fire, startInstall, play, bonus, scheduleSettlement, close, findOffer };
}

module.exports = { createSimulator };
