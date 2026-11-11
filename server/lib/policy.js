'use strict';

/**
 * One place for the age rule and the Terms version.
 *
 * MIN_AGE is 18 because Lootably's Terms of Service say users must be at
 * least 18 (https://lootably.com/terms). CPX Research allows 14+ with a
 * guardian's OK, so 18 is the lowest age both partners allow.
 *
 * Bump TERMS_VERSION whenever the Terms or Privacy Policy change in a way
 * people should agree to again. Signed-in users on an older version are
 * asked to tick the boxes one more time.
 */
const MIN_AGE = 18;
const TERMS_VERSION = '2026-11-11';

function agreeMessage() {
  return 'Please confirm you are ' + MIN_AGE + ' or older and agree to the Terms and Privacy Policy.';
}

function termsCurrent(user) {
  if (!user) return false;
  return String(user.terms_version || '') === TERMS_VERSION &&
    Number(user.age_confirmed || 0) === 1 &&
    Number(user.age_confirmed_min || 0) >= MIN_AGE &&
    !!user.agreed_terms_at;
}

module.exports = { MIN_AGE, TERMS_VERSION, agreeMessage, termsCurrent };
