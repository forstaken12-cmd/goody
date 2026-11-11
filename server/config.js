'use strict';

function num(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function renderPublicUrl() {
  const ext = process.env.RENDER_EXTERNAL_URL;
  if (!ext) return '';
  if (/^https?:\/\//i.test(ext)) return ext.replace(/\/$/, '');
  return 'https://' + ext.replace(/\/$/, '');
}

const config = {
  port: num('PORT', 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || renderPublicUrl() || 'http://localhost:3000',
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
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'goody.sqlite'),
  databaseUrl: process.env.DATABASE_URL || '',
  secureCookies: process.env.SECURE_COOKIES === '1' ||
    process.env.RENDER === 'true' ||
    /^https:/i.test(process.env.PUBLIC_BASE_URL || '') ||
    !!process.env.RENDER_EXTERNAL_URL,
  mailFrom: process.env.MAIL_FROM || '',
  smtpUrl: process.env.SMTP_URL || '',
  smtpHost: process.env.SMTP_HOST || '',
  sendgridKey: process.env.SENDGRID_API_KEY || '',
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  paypalEnv: process.env.PAYPAL_ENV || 'sandbox',
  tremendousApiKey: process.env.TREMENDOUS_API_KEY || '',
  tremendousCampaignId: process.env.TREMENDOUS_CAMPAIGN_ID || '',
  tremendousFunding: process.env.TREMENDOUS_FUNDING_SOURCE_ID || '',
  tremendousEnv: process.env.TREMENDOUS_ENV || 'testflight',
  zbdApiKey: process.env.ZBD_API_KEY || process.env.ZEBEDEE_API_KEY || '',
  btcUsd: num('BTC_USD', 0),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  appleClientId: process.env.APPLE_CLIENT_ID || '',
  appleTeamId: process.env.APPLE_TEAM_ID || '',
  appleKeyId: process.env.APPLE_KEY_ID || '',
  applePrivateKey: process.env.APPLE_PRIVATE_KEY || '',
  appleDomainAssociation: process.env.APPLE_DOMAIN_ASSOCIATION || ''
};


/**
 * Partner postback configs.
 * BitLabs, AdGem, CPX Research, Lootably, and Torox use names and signatures
 * checked against their public docs. Ayet Studios and TheoremReach are stubs
 * until official signature details are confirmed — see PARTNERS.md.
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
    name: 'ayeT-Studios',
    secret: process.env.AYET_SECRET || '',
    style: 'generic',
    enabled: !!process.env.AYET_SECRET,
    notes: 'TODO: public callback docs list macros such as {payout_usd}, {transaction_id}, {external_identifier}, {callback_type}, {is_chargeback}, but I did not find an official signature scheme on the pages checked. Confirm with Ayet before enabling in production. Generic HMAC-SHA256 is only a placeholder.'
  },
  torox: {
    name: 'Torox',
    secret: process.env.TOROX_SECRET || '',
    style: 'torox',
    enabled: !!process.env.TOROX_SECRET,
    successBody: '1',
    notes: 'Publisher integration guide: sig = md5(oid + "-" + user_id + "-" + app placement key). Respond with the plain text 1. Reversals (if enabled) use a new id and a negative payout.'
  },
  lootably: {
    name: 'Lootably',
    secret: process.env.LOOTABLY_POSTBACK_SECRET || '',
    style: 'lootably',
    enabled: !!process.env.LOOTABLY_POSTBACK_SECRET,
    successBody: '1',
    notes: 'Public docs: GET postback, sha256(userID + ip + revenue + currencyReward + postback secret) compared to {hash}. Credit publisher USD from {revenue}, not {currencyReward}. Respond with the plain text 1.'
  },
  theoremreach: {
    name: 'TheoremReach',
    secret: process.env.THEOREMREACH_SECRET || '',
    style: 'generic',
    enabled: !!process.env.THEOREMREACH_SECRET,
    notes: 'TODO: TheoremReach documents HMAC-secured offerwall callbacks, but I could not confirm exact parameter names or the HMAC formula from the public pages I could open. Confirm official docs in the publisher dashboard before enabling.'
  }
};

module.exports = config;
