const { verifyAuthToken } = require('../services/reconAuthService');

function reconAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const payload = verifyAuthToken(token);
  if (!payload) {
    return res.status(401).json({ message: 'Invalid or expired session' });
  }

  req.reconUser = payload;
  return next();
}

function requireReconRole(...roles) {
  return (req, res, next) => {
    if (!req.reconUser || !roles.includes(req.reconUser.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return next();
  };
}

module.exports = {
  reconAuth,
  requireReconRole,
};