const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const reconAuthRoutes = require('./routes/reconAuth');
const customerRoutes = require('./routes/customers');
const reconciliationRoutes = require('./routes/reconciliation');
const syncRoutes = require('./routes/sync');
const updateRoutes = require('./routes/updates');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'central-sync-server', timestamp: new Date().toISOString() });
});

app.use('/updates', updateRoutes);
app.use('/api/recon/auth', reconAuthRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/recon', reconciliationRoutes);
app.use('/api/sync', syncRoutes);

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const statusCode = Number(error.statusCode || error.status || 500);
  if (statusCode >= 500) {
    console.error('[http] unhandled request error', error);
  }

  return res.status(statusCode).json({
    success: false,
    code: error.code || 'INTERNAL_SERVER_ERROR',
    message: statusCode >= 500 ? 'Internal server error' : error.message,
    details: error.details,
  });
});

module.exports = { app };
