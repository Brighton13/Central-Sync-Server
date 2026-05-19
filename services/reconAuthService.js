const crypto = require('crypto');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
const KEY_LENGTH = 64;
const PASSWORD_SEPARATOR = ':';

function getAuthSecret() {
  return process.env.RECON_AUTH_SECRET || process.env.SYNC_SERVER_TOKEN || 'recon-dashboard-local-secret';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}${PASSWORD_SEPARATOR}${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(PASSWORD_SEPARATOR)) {
    return false;
  }

  const [salt, expectedHash] = storedHash.split(PASSWORD_SEPARATOR);
  const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const actualBuffer = Buffer.from(derivedKey, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function signPayload(payload) {
  return crypto
    .createHmac('sha256', getAuthSecret())
    .update(payload)
    .digest('hex');
}

function createAuthToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    fullName: user.full_name,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  const expectedSignature = signPayload(encodedPayload);

  if (signature !== expectedSignature) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

function sanitizeReconUser(user) {
  const plain = user.toJSON ? user.toJSON() : user;
  return {
    id: plain.id,
    fullName: plain.full_name,
    email: plain.email,
    role: plain.role,
    active: plain.active,
    lastLoginAt: plain.last_login_at,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function ensureDefaultReconUsers(models) {
  const count = await models.reconUser.count();
  if (count > 0) {
    return;
  }

  const defaults = [
    {
      full_name: process.env.RECON_ADMIN_NAME || 'Recon Admin',
      email: (process.env.RECON_ADMIN_EMAIL || 'admin@recon.local').toLowerCase(),
      password_hash: hashPassword(process.env.RECON_ADMIN_PASSWORD || 'admin123'),
      role: 'admin',
      active: true,
    },
    {
      full_name: process.env.RECON_FINANCE_NAME || 'Finance Officer',
      email: (process.env.RECON_FINANCE_EMAIL || 'finance@recon.local').toLowerCase(),
      password_hash: hashPassword(process.env.RECON_FINANCE_PASSWORD || 'finance123'),
      role: 'finance',
      active: true,
    },
  ];

  await models.reconUser.bulkCreate(defaults);
}

module.exports = {
  createAuthToken,
  ensureDefaultReconUsers,
  hashPassword,
  sanitizeReconUser,
  verifyAuthToken,
  verifyPassword,
};