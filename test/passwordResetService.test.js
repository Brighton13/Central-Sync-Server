const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generateOtp,
  hashOtp,
  otpMatches,
} = require('../services/passwordResetService');

test('generateOtp always returns a six-digit code', () => {
  for (let index = 0; index < 50; index += 1) {
    assert.match(generateOtp(), /^\d{6}$/);
  }
});

test('OTP hashes are user-bound and verify safely', () => {
  const hash = hashOtp(42, '012345');
  assert.equal(hash.length, 64);
  assert.equal(otpMatches(42, '012345', hash), true);
  assert.equal(otpMatches(42, '012346', hash), false);
  assert.equal(otpMatches(43, '012345', hash), false);
  assert.equal(otpMatches(42, '012345', 'bad-hash'), false);
});
