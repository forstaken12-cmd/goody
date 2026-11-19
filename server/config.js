'use strict';

const DEFAULT_CONTACT_EMAIL = 'forstaken12@gmail.com';

function isContactEmail(value) {
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(String(value || '').trim());
}

function resolveContactEmail(raw) {
  const e = String(raw == null ? '' : raw).trim();
  return isContactEmail(e) ? e : DEFAULT_CONTACT_EMAIL;
}

function envStr(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

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
  publicBaseUrl: envStr('PUBLIC_BASE_URL') || renderPublicUrl() || 'http://localhost:3000',
  canonicalRedirect: envStr('CANONICAL_REDIRECT') !== '0',
  contactEmail: resolveContactEmail(envStr('CONTACT_EMAIL')),
  turnstileSiteKey: envStr('TURNSTILE_SITE_KEY'),
  reloadlyClientId: envStr('RELOADLY_CLIENT_ID'),
  reloadlyClientSecret: envStr('RELOADLY_CLIENT_SECRET'),
  reloadlyEnv: envStr('RELOADLY_ENV') || 'sandbox',
  // Locks gift card codes in the database. Falls back to the Reloadly secret.
  giftCodeKey: envStr('GIFT_CODE_KEY'),
  turnstileSecretKey: envStr('TURNSTILE_SECRET_KEY'),
  sharePct: Math.min(0.9, Math.max(0.5, num('USER_SHARE', 0.7))),
  pointUsd: num('POINT_USD', 0.001),
  firstCashoutUsd: num('FIRST_CASHOUT_USD', 0.5),
  // Floor for every cash out, including the first one. Method mins still apply if higher.
  minCashoutUsd: Math.max(0, num('MIN_CASHOUT_USD', 5)),
  // Partner credits stay pending this many days before they can be cashed out. 0 = immediate.
  earnHoldDays: Math.max(0, num('EARN_HOLD_DAYS', 3)),
  // When true, a new cash-out is approved (and sent, if keys are set) without an admin click.
  payoutAutoApprove: /^(1|true|yes)$/i.test(envStr('PAYOUT_AUTO_APPROVE')),
  mins: {
    lightning: num('MIN_LIGHTNING_USD', 0.8),
    paypal: num('MIN_PAYPAL_USD', 1.2),
    gift: num('MIN_GIFT_USD', 2.0)
  },
  tz: process.env.TZ || 'America/Boise',
  // Off unless explicitly set to 1. Must stay off on the live site (real cash-outs).
  demoPartner: process.env.DEMO_PARTNER === '1',
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
  mailFrom: envStr('MAIL_FROM'),
  smtpUrl: envStr('SMTP_URL'),
  smtpHost: envStr('SMTP_HOST'),
  sendgridKey: envStr('SENDGRID_API_KEY'),
  brevoApiKey: envStr('BREVO_API_KEY'),
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  paypalEnv: process.env.PAYPAL_ENV || 'sandbox',
  tremendousApiKey: process.env.TREMENDOUS_API_KEY || '',
  tremendousCampaignId: process.env.TREMENDOUS_CAMPAIGN_ID || '',
  tremendousFunding: process.env.TREMENDOUS_FUNDING_SOURCE_ID || '',
  tremendousEnv: process.env.TREMENDOUS_ENV || 'testflight',
  zbdApiKey: process.env.ZBD_API_KEY || process.env.ZEBEDEE_API_KEY || '',
  btcUsd: num('BTC_USD', 0),
  googleClientId: envStr('GOOGLE_CLIENT_ID'),
  googleClientSecret: envStr('GOOGLE_CLIENT_SECRET'),
  appleClientId: envStr('APPLE_CLIENT_ID'),
  appleTeamId: envStr('APPLE_TEAM_ID'),
  appleKeyId: envStr('APPLE_KEY_ID'),
  applePrivateKey: envStr('APPLE_PRIVATE_KEY'),
  appleDomainAssociation: envStr('APPLE_DOMAIN_ASSOCIATION')
};


/**
 * Partner postback configs.
 * Names and signatures are checked against each partner's docs — see PARTNERS.md.
 * A partner is only switched on (wall shown, postbacks accepted) once its secret env vars are set.
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
    // CPX calls it the app "security hash" (older Goody docs said CPX_SECURE_HASH; both work).
    secret: process.env.CPX_SECURITY_HASH || process.env.CPX_SECURE_HASH || '',
    appId: String(process.env.CPX_APP_ID || '38062').trim(),
    style: 'cpx',
    source: 'survey',
    label: 'CPX Research survey',
    enabled: !!(process.env.CPX_SECURITY_HASH || process.env.CPX_SECURE_HASH),
    // Optional: comma-separated IPs allowed to send CPX postbacks. CPX does not publish
    // a fixed list in its public docs, so this is off unless you set it.
    allowedIps: String(process.env.CPX_POSTBACK_IPS || '').split(',').map((x) => x.trim()).filter(Boolean),
    notes: 'Survey wall iframe: offers.cpx-research.com/index.php?app_id&ext_user_id&secure_hash=md5(ext_user_id + "-" + security hash). Postback: status 1 = completed, 2 = canceled (reversal); hash = md5(trans_id + "-" + security hash). Credit from amount_usd (publisher USD), not amount_local.'
  },

  ayet: {
    name: 'ayeT-Studios',
    // Publisher API key (ayeT dashboard → Settings). Signs the X-Ayetstudios-Security-Hash header.
    secret: envStr('AYET_API_KEY') || envStr('AYET_SECRET'),
    placementId: envStr('AYET_PLACEMENT_ID') || '26403',
    surveySlot: envStr('AYET_SURVEYWALL_SLOT') || '31452',
    offerSlot: envStr('AYET_OFFERWALL_SLOT') || '31454',
    style: 'ayet',
    label: 'ayeT-Studios',
    enabled: !!(envStr('AYET_API_KEY') || envStr('AYET_SECRET')),
    allowedIps: String(process.env.AYET_POSTBACK_IPS || '').split(',').map((x) => x.trim()).filter(Boolean),
    notes: 'Web surveywall surveys.ayet.io/surveys?adSlot&external_identifier, offerwall offerwall.ayet.io/offers?adSlot&externalIdentifier. Callback: header X-Ayetstudios-Security-Hash = HMAC-SHA256(sorted query string, publisher API key). Credit payout_usd; is_chargeback=1 with transaction_id "r-<original>" claws back.'
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
    secret: envStr('THEOREMREACH_SECRET'),
    // The API key is public (it goes in the survey wall link). App 26008.
    apiKey: envStr('THEOREMREACH_API_KEY') || 'b02a2f63e99174f8bddf801018dd',
    style: 'theoremreach',
    label: 'TheoremReach survey',
    enabled: !!envStr('THEOREMREACH_SECRET'),
    // TheoremReach signs the URL it called; check it against the live domain too.
    callbackBases: (envStr('THEOREMREACH_CALLBACK_BASE') || 'https://goody.day').split(',').map((x) => x.trim()).filter(Boolean),
    allowedIps: String(process.env.THEOREMREACH_POSTBACK_IPS || '').split(',').map((x) => x.trim()).filter(Boolean),
    notes: 'Wall: theoremreach.com/respondent_entry/direct?api_key&user_id&transaction_id (+ hash). Callback hash = base64url(HMAC-SHA1(secret, callback URL before &hash=)). reversal=true claws back the same tx_id; debug=true is ignored. Credit {currency} / {reward_amount_in_dollars} (USD).'
  },
  rapidoreach: {
    name: 'RapidoReach',
    // App Secret (also called Transaction Key) signs txnHash; App Key signs offerHash and the wall UID.
    secret: envStr('RAPIDOREACH_APP_SECRET'),
    appKey: envStr('RAPIDOREACH_APP_KEY'),
    appId: envStr('RAPIDOREACH_APP_ID') || 'YqyrVnOaFtt',
    style: 'rapidoreach',
    source: 'survey',
    label: 'RapidoReach survey',
    successBody: '1',
    enabled: !!(envStr('RAPIDOREACH_APP_SECRET') && envStr('RAPIDOREACH_APP_KEY')),
    // RapidoReach dashboard lists 161.97.78.55, 173.212.227.149, 75.119.139.250, 75.119.139.251.
    allowedIps: String(process.env.RAPIDOREACH_POSTBACK_IPS || '').split(',').map((x) => x.trim()).filter(Boolean),
    notes: 'Wall: rapidoreach.com/ofw/?userId=<uid>-<appId>-md5(uid-appId-appKey). Callback GET: txnHash = md5(transactionId + App Secret), offerHash = md5(transactionId + App Key). status C credits amt (USD); F/P only if paid; R claws back.'
  }
};

config.DEFAULT_CONTACT_EMAIL = DEFAULT_CONTACT_EMAIL;
config.resolveContactEmail = resolveContactEmail;
module.exports = config;

