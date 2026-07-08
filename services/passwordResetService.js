const crypto = require('crypto');
const nodemailer = require('nodemailer');

const OTP_TTL_MINUTES = Math.max(Number(process.env.PASSWORD_RESET_OTP_TTL_MINUTES || 10), 1);
const OTP_MAX_ATTEMPTS = Math.max(Number(process.env.PASSWORD_RESET_OTP_MAX_ATTEMPTS || 5), 1);
const OTP_RESEND_SECONDS = Math.max(Number(process.env.PASSWORD_RESET_OTP_RESEND_SECONDS || 60), 1);

function getOtpSecret() {
  return process.env.PASSWORD_RESET_OTP_SECRET
    || process.env.RECON_AUTH_SECRET
    || process.env.SYNC_SERVER_TOKEN
    || 'recon-dashboard-local-secret';
}

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashOtp(userId, otp) {
  return crypto.createHmac('sha256', getOtpSecret()).update(`${userId}:${otp}`).digest('hex');
}

function otpMatches(userId, otp, expectedHash) {
  const actual = Buffer.from(hashOtp(userId, otp), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const host = String(process.env.SMTP_HOST || '').trim();
  const from = String(process.env.SMTP_FROM || user).trim();
  if (!host || !user || !pass || !from || !Number.isFinite(port)) {
    const error = new Error('Password-reset email is not configured');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }
  return { host, port, user, pass, from };
}

async function sendPasswordResetOtp(user, otp) {
  const config = smtpConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || config.port === 465,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' },
  });
  const company = String(process.env.COMPANY_NAME || 'SwiftCart').trim();
  await transporter.sendMail({
    from: config.from,
    to: user.email,
    subject: `${company} password reset code`,
    text: `Your password reset code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
    html: `<p>Your ${company} password reset code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${otp}</p><p>It expires in ${OTP_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>`,
  });
}

module.exports = {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_TTL_MINUTES,
  generateOtp,
  hashOtp,
  otpMatches,
  sendPasswordResetOtp,
};
