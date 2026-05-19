function syncAuth(req, res, next) {
  const configuredToken = process.env.SYNC_SERVER_TOKEN;

  if (!configuredToken) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || token !== configuredToken) {
    return res.status(401).json({ message: 'Unauthorized sync request' });
  }

  return next();
}

module.exports = syncAuth;
