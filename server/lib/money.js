'use strict';

function money(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function usdToPts(usd, pointUsd) {
  if (usd <= 0 || pointUsd <= 0) return 0;
  const unit = Math.round(pointUsd * 1e6);
  const val = Math.round(usd * 1e6);
  if (unit <= 0) return 0;
  return Math.floor(val / unit);
}

function ptsToUsd(pts, pointUsd) {
  return money(Math.max(0, pts) * pointUsd);
}

function userShare(partnerUsd, sharePct) {
  const usd = money(Math.max(0, Number(partnerUsd) || 0));
  const user = money(usd * sharePct);
  const app = money(usd - user);
  return { partnerUsd: usd, userUsd: user, appUsd: app, points: 0 };
}

function creditFromPartner(partnerUsd, sharePct, pointUsd) {
  const parts = userShare(partnerUsd, sharePct);
  parts.points = usdToPts(parts.userUsd, pointUsd);
  return parts;
}

function todayStr(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Boise',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(new Date());
}

function yesterdayStr(tz) {
  const now = new Date();
  // Walk back 24h and also check calendar in tz: subtract one calendar day from todayStr
  const today = todayStr(tz);
  const [y, m, d] = today.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - 1);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isoNow() {
  return new Date().toISOString();
}

module.exports = { money, usdToPts, ptsToUsd, userShare, creditFromPartner, todayStr, yesterdayStr, isoNow };
