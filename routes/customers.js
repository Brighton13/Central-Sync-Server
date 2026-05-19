const express = require('express');

const syncAuth = require('../middleware/syncAuth');

const router = express.Router();

function normalizeTpin(rawValue) {
  return String(rawValue || '').replace(/\D/g, '').trim();
}

function sanitizeCustomer(customerRecord) {
  if (!customerRecord) {
    return null;
  }

  const plain = customerRecord.toJSON ? customerRecord.toJSON() : customerRecord;
  return {
    id: plain.id,
    tpin: plain.tpin,
    name: plain.name || plain.legal_name || null,
    legalName: plain.legal_name || plain.name || null,
    phone: plain.phone || null,
    email: plain.email || null,
    address: plain.address || null,
    sourceSystem: plain.source_system || null,
    lookupSource: plain.lookup_source || null,
    lastVerifiedAt: plain.last_verified_at || null,
    lastSeenAt: plain.last_seen_at || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

router.use(syncAuth);

router.get('/lookup', async (req, res) => {
  const normalizedTpin = normalizeTpin(req.query.tpin);
  if (!normalizedTpin) {
    return res.status(400).json({ message: 'A valid TPIN is required' });
  }

  const models = req.app.locals.models;
  const customerRecord = await models.customerDirectory.findOne({ where: { tpin: normalizedTpin } });

  if (!customerRecord) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  await customerRecord.update({ last_seen_at: new Date() });
  return res.json({ success: true, customer: sanitizeCustomer(customerRecord) });
});

router.put('/by-tpin/:tpin', async (req, res) => {
  const normalizedTpin = normalizeTpin(req.params.tpin || req.body?.tpin);
  if (!normalizedTpin) {
    return res.status(400).json({ message: 'A valid TPIN is required' });
  }

  const name = String(req.body?.name || req.body?.legalName || '').trim();
  if (!name) {
    return res.status(400).json({ message: 'Customer name is required' });
  }

  const models = req.app.locals.models;
  const [customerRecord, created] = await models.customerDirectory.findOrCreate({
    where: { tpin: normalizedTpin },
    defaults: {
      tpin: normalizedTpin,
      name,
      legal_name: String(req.body?.legalName || name).trim(),
      phone: req.body?.phone || null,
      email: req.body?.email || null,
      address: req.body?.address || null,
      source_system: req.body?.sourceSystem || 'pos-backend',
      lookup_source: req.body?.lookupSource || null,
      last_verified_at: req.body?.lastVerifiedAt || new Date(),
      last_seen_at: new Date(),
    },
  });

  if (!created) {
    await customerRecord.update({
      name,
      legal_name: String(req.body?.legalName || name).trim(),
      phone: req.body?.phone || customerRecord.phone,
      email: req.body?.email || customerRecord.email,
      address: req.body?.address || customerRecord.address,
      source_system: req.body?.sourceSystem || customerRecord.source_system,
      lookup_source: req.body?.lookupSource || customerRecord.lookup_source,
      last_verified_at: req.body?.lastVerifiedAt || customerRecord.last_verified_at || new Date(),
      last_seen_at: new Date(),
    });
  }

  return res.status(created ? 201 : 200).json({ success: true, customer: sanitizeCustomer(customerRecord) });
});

module.exports = router;