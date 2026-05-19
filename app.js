const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const reconAuthRoutes = require('./routes/reconAuth');
const customerRoutes = require('./routes/customers');
const reconciliationRoutes = require('./routes/reconciliation');
const syncRoutes = require('./routes/sync');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'central-sync-server', timestamp: new Date().toISOString() });
});

app.use('/api/recon/auth', reconAuthRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/recon', reconciliationRoutes);
app.use('/api/sync', syncRoutes);

module.exports = { app };
