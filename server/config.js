'use strict';

function num(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: num('PORT', 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  sharePct: Math.min(0.9, Math.max(0.5, num('USER_SHARE', 0.7))),
  pointUsd: num('POINT_USD', 0.001),
  firstCashoutUsd: num('FIRST_CASHOUT_USD', 0.5),
  mins: {
    lightning: num('MIN_LIGHTNING_USD', 0.8),
    paypal: num('MIN_PAYPAL_USD', 1.2),
    gift: num('MIN_GIFT_USD', 2.0)
  },
  tz: process.env.TZ || 'America/Boise',
  demoPartner: process.env.DEMO_PARTNER !== '0',
  demoPendingMs: num('DEMO_PENDING_MS', 1200),
  demoPaidMs: num('DEMO_PAID_MS', 2200),
  demoRejectRate: num('DEMO_REJECT_RATE', 0.1),
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me-admin',
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'goody.sqlite')
};

/**
 * Partner postback configs.
 * Only BitLabs (HMAC-SHA1 of the URL), AdGem (HMAC-SHA256), and CPX Research
 * (md5 of trans_id + secret) use names checked against public docs.
 * Ayet Studios and Torox are stubs — confirm official docs before launch.
 */
config.partners = {
  demo: {
    name: 'Demo partner',
    secret: process.env.DEMO_PARTNER_SECRET || 'change-me-demo-secret',
    style: 'generic',
    enabled: config.demoPartner
  },
  bitlabs: {
    name: 'BitLabs',
    secret: process.env.BITLABS_SECRET || '',
    style: 'bitlabs',
    enabled: !!process.env.BITLABS_SECRET,
    notes: 'Public docs: HMAC-SHA1 over the full callback URL excluding &hash=. Common macros: uid / USER:UID, tx / TX, raw / VALUE:USD, val / VALUE:CURRENCY, type / TYPE (COMPLETE, SCREENOUT). Confirm official reversal/chargeback type before launch.'
  },
  adgem: {
    name: 'AdGem',
    secret: process.env.ADGEM_POSTBACK_KEY || '',
    style: 'adgem',
    enabled: !!process.env.ADGEM_POSTBACK_KEY,
    notes: 'Public docs: v3 POST JSON, Signature header = HMAC-SHA256 of raw body. v2 GET uses verifier = HMAC-SHA256 of URL without verifier. Fields include player_id, payout, transaction_id, conversion_id, goal_id.'
  },
  cpx: {
    name: 'CPX Research',
    secret: process.env.CPX_SECURE_HASH || '',
    style: 'cpx',
    enabled: !!process.env.CPX_SECURE_HASH,
    notes: 'Publisher docs/examples: md5(trans_id + "-" + app secure hash) in secure_hash. Params: user_id, trans_id, amount_usd, amount_local, status (1 = complete, 2 = canceled). Re-check the live dashboard docs at launch.'
  },
  ayet: {
    name: 'Ayet Studios',
    secret: process.env.AYET_SECRET || '',
    style: 'generic',
    enabled: !!process.env.AYET_SECRET,
    notes: 'TODO: confirm official postback parameter names and signature from Ayet Studios docs before enabling in production. Generic HMAC-SHA256 handler is a placeholder.'
  },
  torox: {
    name: 'Torox',
    secret: process.env.TOROX_SECRET || '',
    style: 'generic',
    enabled: !!process.env.TOROX_SECRET,
    notes: 'TODO: confirm official postback parameter names and signature from Torox docs before enabling in production. Generic HMAC-SHA256 handler is a placeholder.'
  }
};

module.exports = config;
