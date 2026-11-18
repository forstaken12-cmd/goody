'use strict';

// Recommended surveys for the home screen. Each partner with a documented per-user survey list
// API is asked server-side (short timeout, quiet failure). Results are cached per user briefly.
// Partners without a list API (or not set up for it) come back as wall cards instead.
const { md5 } = require('./postback');
const { creditFromPartner } = require('./money');

const MAX_SURVEYS = 6;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function pointsFromUsd(usd, cfg) {
  const n = toNum(usd);
  if (!(n > 0)) return 0;
  return creditFromPartner(n, cfg.sharePct, cfg.pointUsd).points;
}
function httpsUrl(u) {
  return typeof u === 'string' && /^https:\/\//i.test(u) ? u : '';
}
function titleCase(s) {
  return String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function getJson(fetchFn, url, init, timeoutMs) {
  const res = await fetchFn(url, Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, init || {}));
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
  return await res.json();
}

/** CPX Research (doc.php): get-surveys.php?app_id&ext_user_id&output_method=api&ip_user&user_agent&limit&secure_hash. */
async function fetchCpx(ctx) {
  const c = ctx.cfg.partners.cpx;
  const q = new URLSearchParams({
    app_id: String(c.appId || '38062'),
    ext_user_id: ctx.userId,
    output_method: 'api',
    ip_user: ctx.ip || '',
    user_agent: ctx.userAgent || '',
    limit: '12',
    secure_hash: md5(ctx.userId + '-' + c.secret)
  });
  const data = await getJson(ctx.fetchFn, 'https://live-api.cpx-research.com/api/get-surveys.php?' + q.toString(), { headers: { Accept: 'application/json' } }, ctx.timeoutMs);
  const list = data && Array.isArray(data.surveys) ? data.surveys : [];
  return list.map((s) => ({
    partner: 'cpx',
    partnerName: 'CPX Research',
    id: 'cpx-' + s.id,
    title: 'Opinion survey',
    minutes: Math.max(1, Math.round(toNum(s.loi)) || 0),
    points: pointsFromUsd(s.payout_publisher_usd, ctx.cfg),
    top: String(s.top) === '1',
    url: httpsUrl(s.href)
  }));
}

/**
 * ayeT-Studios Surveywall API: GET /surveys/surveywall_api/{adslot}?external_identifier&ip&user_agent&language.
 * cpi is in the adslot's currency, which is set to 700 per $1 like Goody's own rate.
 */
async function fetchAyet(ctx) {
  const c = ctx.cfg.partners.ayet;
  const q = new URLSearchParams({ external_identifier: ctx.userId, num_surveys: '12', survey_sorting: 'eepm' });
  if (ctx.ip) q.set('ip', ctx.ip);
  if (ctx.userAgent) q.set('user_agent', ctx.userAgent);
  if (ctx.language) q.set('language', ctx.language);
  const data = await getJson(ctx.fetchFn, 'https://www.ayetstudios.com/surveys/surveywall_api/' + encodeURIComponent(c.surveySlot) + '?' + q.toString(), { headers: { Accept: 'application/json' } }, ctx.timeoutMs);
  const list = data && Array.isArray(data.surveys) ? data.surveys : [];
  return list.map((s) => ({
    partner: 'ayet',
    partnerName: 'ayeT-Studios',
    id: 'ayet-' + s.id,
    title: s.category ? titleCase(s.category) + ' survey' : 'Opinion survey',
    minutes: Math.max(1, Math.round(toNum(s.loi)) || 0),
    points: Math.max(0, Math.floor(toNum(s.cpi)) || 0),
    top: !!s.is_new,
    url: httpsUrl(s.url)
  }));
}

/**
 * RapidoReach Survey API: POST /getallsurveys-api with X-RapidoReach-Api-Key. City and locale are
 * required by RapidoReach, so this only runs when Cloudflare passes the visitor's city and country.
 * CPI is the USD value before currency conversion.
 */
async function fetchRapido(ctx) {
  const c = ctx.cfg.partners.rapidoreach;
  if (!ctx.city || !ctx.country || !ctx.ip) return [];
  const body = {
    UserId: ctx.userId,
    AppId: String(c.appId),
    IpAddress: ctx.ip,
    City: ctx.city,
    CountryLanguageCode: 'ENG-' + ctx.country
  };
  const data = await getJson(ctx.fetchFn, 'https://www.rapidoreach.com/getallsurveys-api', {
    method: 'POST',
    headers: { 'X-RapidoReach-Api-Key': c.appKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  }, ctx.timeoutMs);
  const list = data && data.ErrorCode === 'SUCCESS' && Array.isArray(data.Data) ? data.Data : [];
  return list.map((s) => {
    const name = s.Survey && typeof s.Survey.SurveyName === 'string' ? s.Survey.SurveyName.trim() : '';
    return {
      partner: 'rapidoreach',
      partnerName: 'RapidoReach',
      id: 'rr-' + s.SurveyNumber,
      title: name && name.length <= 48 ? name : 'Opinion survey',
      minutes: Math.max(1, Math.round(toNum(s.LOI)) || 0),
      points: pointsFromUsd(s.CPI, ctx.cfg),
      top: false,
      url: httpsUrl(s.SurveyUrl)
    };
  });
}

const SOURCES = {
  cpx: { fetch: fetchCpx, ready: (cfg) => on(cfg, 'cpx'), wall: 'cpx' },
  ayet: { fetch: fetchAyet, ready: (cfg) => on(cfg, 'ayet') && !!cfg.partners.ayet.surveySlot, wall: 'ayet_surveys' },
  rapidoreach: { fetch: fetchRapido, ready: (cfg) => on(cfg, 'rapidoreach') && !!cfg.partners.rapidoreach.appKey, wall: 'rapidoreach' }
};
function on(cfg, key) {
  const c = cfg.partners && cfg.partners[key];
  return !!(c && c.enabled && c.secret);
}

function rankSurveys(items) {
  const good = items.filter((s) => s.url && s.points > 0 && s.minutes > 0);
  good.forEach((s) => { s.ppm = Math.round((s.points / s.minutes) * 10) / 10; });
  good.sort((a, b) => b.ppm - a.ppm || b.points - a.points);
  const seen = new Set();
  const out = [];
  for (const s of good) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
    if (out.length >= MAX_SURVEYS) break;
  }
  out.forEach((s, i) => { s.topPick = i === 0; delete s.top; });
  return out;
}

function createRecommender(cfg, opts) {
  opts = opts || {};
  const fetchFn = opts.fetchFn || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs || 3500;
  const ttlMs = opts.ttlMs || 3 * 60 * 1000;
  const log = opts.log || ((m) => console.warn(m));
  const cache = new Map();

  async function forUser(user, reqInfo, walls) {
    const key = user.public_id;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Object.assign({ cached: true }, hit.data);

    const ctx = Object.assign({ cfg, fetchFn, timeoutMs, userId: key }, reqInfo || {});
    const names = Object.keys(SOURCES).filter((k) => SOURCES[k].ready(cfg));
    const results = await Promise.all(names.map(async (k) => {
      try {
        return { k, items: await SOURCES[k].fetch(ctx) };
      } catch (e) {
        log('Survey list failed | partner=' + k + ' | ' + (e && e.name === 'TimeoutError' ? 'timeout' : (e && e.status ? 'HTTP ' + e.status : 'error')));
        return { k, items: [] };
      }
    }));
    const surveys = rankSurveys([].concat(...results.map((r) => r.items)));
    const withSurveys = new Set(surveys.map((s) => s.partner));
    // Wall cards for every ready wall whose partner gave us no individual surveys.
    const wallCards = Object.keys(walls || {}).filter((w) => walls[w] && w !== 'ayet_offers' && !withSurveys.has(w.split('_')[0]));
    const data = { surveys, walls: wallCards };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return Object.assign({ cached: false }, data);
  }
  return { forUser, cache };
}

module.exports = { createRecommender, rankSurveys, fetchCpx, fetchAyet, fetchRapido, MAX_SURVEYS };
