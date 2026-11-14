'use strict';

/**
 * Small AES-256-GCM box for gift card codes at rest.
 * Key material comes from GIFT_CODE_KEY (recommended), falling back to the
 * Reloadly client secret. Codes are never logged.
 */
const crypto = require('crypto');

function keyFrom(material) {
  if (!material) throw new Error('No key to lock gift codes.');
  return crypto.createHash('sha256').update('goody-gift-code-v1:' + String(material)).digest();
}

function seal(plain, material) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(material), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(boxed, material) {
  const s = String(boxed || '');
  if (!s.startsWith('v1:')) throw new Error('Unknown code format.');
  const buf = Buffer.from(s.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(material), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { seal, open };
