'use strict';

const { todayStr, yesterdayStr, isoNow } = require('./money');
const { applyPostback } = require('./ledger');
const { signGeneric } = require('./postback');

const GOALS = [
  { key: 'checkin', label: 'Check in today', target: 1 },
  { key: 'task', label: 'Finish 1 task', target: 1 },
  { key: 'points', label: 'Earn 200 points', target: 200 }
];

function getStreak(db, userId, tz) {
  let row = db.get('SELECT * FROM streaks WHERE user_id = ?', [userId]);
  if (!row) {
    db.run('INSERT INTO streaks (user_id, current, best, last_date) VALUES (?, 0, 0, NULL)', [userId]);
    row = db.get('SELECT * FROM streaks WHERE user_id = ?', [userId]);
  }
  const today = todayStr(tz);
  const yest = yesterdayStr(tz);
  let current = row.current || 0;
  if (row.last_date && row.last_date !== today && row.last_date !== yest) current = 0;
  return { current, best: row.best || 0, lastDate: row.last_date || null, checkedInToday: row.last_date === today };
}

function applyCheckin(db, user, { tz, fireBonus }) {
  const today = todayStr(tz);
  const yest = yesterdayStr(tz);
  let row = db.get('SELECT * FROM streaks WHERE user_id = ?', [user.id]);
  if (!row) {
    db.run('INSERT INTO streaks (user_id, current, best, last_date) VALUES (?, 0, 0, NULL)', [user.id]);
    row = db.get('SELECT * FROM streaks WHERE user_id = ?', [user.id]);
  }
  if (row.last_date === today) {
    return { already: true, streak: getStreak(db, user.id, tz) };
  }
  let current = 1;
  if (row.last_date === yest) current = (row.current || 0) + 1;
  const best = Math.max(row.best || 0, current);
  db.run('UPDATE streaks SET current = ?, best = ?, last_date = ? WHERE user_id = ?', [
    current, best, today, user.id
  ]);
  const streak = getStreak(db, user.id, tz);
  if (fireBonus) fireBonus({ kind: 'daily', day: current, user });
  if ((current === 3 || current === 7) && fireBonus) fireBonus({ kind: 'streak', day: current, user });
  return { already: false, streak };
}

function paidToday(db, userId, today) {
  const rows = db.all(
    `SELECT * FROM ledger WHERE user_id = ? AND status = 'paid' AND entry_type = 'credit' AND created_at >= ?`,
    [userId, today + 'T00:00:00.000Z']
  );
  // created_at is ISO UTC; filter by local date is imperfect if we only use UTC midnight.
  // We also store dates in ISO; for goals, compare using the date prefix after converting? Simpler:
  // Use updated_at/created_at ISO and accept UTC day if needed. Better: include rows whose
  // created_at in tz equals today. We'll pass today and also accept a looser window:
  return rows;
}

function computeGoals(db, userId, tz) {
  const today = todayStr(tz);
  const streak = getStreak(db, userId, tz);
  const credits = db.all(
    `SELECT * FROM ledger WHERE user_id = ? AND entry_type = 'credit' AND status = 'paid'`,
    [userId]
  );
  // Filter to today's local date by converting ISO to tz date
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const todays = credits.filter((r) => fmt.format(new Date(r.created_at)) === today);
  const taskSources = ['offer', 'survey', 'playtime'];
  const tasks = todays.filter((r) => taskSources.includes(r.source)).length;
  const pts = todays.reduce((s, r) => s + (r.points || 0), 0);

  const progress = {
    checkin: streak.checkedInToday ? 1 : 0,
    task: Math.min(1, tasks),
    points: Math.min(200, pts)
  };

  return GOALS.map((g) => {
    let row = db.get('SELECT * FROM daily_goals WHERE user_id = ? AND date = ? AND goal_key = ?', [
      userId, today, g.key
    ]);
    const p = progress[g.key] || 0;
    const done = p >= g.target;
    if (!row) {
      db.run(
        'INSERT INTO daily_goals (user_id, date, goal_key, target, progress, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, today, g.key, g.target, p, done ? isoNow() : null]
      );
    } else if (row.progress !== p || (!row.completed_at && done)) {
      db.run(
        'UPDATE daily_goals SET progress = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?',
        [p, done ? isoNow() : null, row.id]
      );
    }
    row = db.get('SELECT * FROM daily_goals WHERE user_id = ? AND date = ? AND goal_key = ?', [
      userId, today, g.key
    ]);
    return {
      key: g.key,
      label: g.label,
      target: g.target,
      progress: p,
      done,
      bonusTx: row && row.bonus_tx
    };
  });
}

function maybeGoalBonus(db, user, { tz, fireBonus }) {
  const goals = computeGoals(db, user.id, tz);
  if (!goals.every((g) => g.done)) return { ready: false, goals };
  const already = goals.some((g) => g.bonusTx);
  if (already) return { ready: true, already: true, goals };
  const tx = 'goal-' + todayStr(tz) + '-' + user.public_id;
  if (fireBonus) fireBonus({ kind: 'goals', user, tx });
  const today = todayStr(tz);
  db.run('UPDATE daily_goals SET bonus_tx = ? WHERE user_id = ? AND date = ?', [tx, user.id, today]);
  return { ready: true, already: false, goals: computeGoals(db, user.id, tz) };
}

module.exports = { GOALS, getStreak, applyCheckin, computeGoals, maybeGoalBonus };
