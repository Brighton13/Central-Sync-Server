const express = require('express');
const { Op } = require('sequelize');

const { reconAuth, requireReconRole } = require('../middleware/reconAuth');
const {
  createAuthToken,
  hashPassword,
  sanitizeReconUser,
  verifyPassword,
} = require('../services/reconAuthService');
const {
  buildActorFromReconUser,
  buildTargetFromReconUser,
  logReconRequestAudit,
} = require('../services/reconAuditLogService');

const router = express.Router();

function loadActorUser(req, models) {
  if (!req.reconUser?.sub) {
    return null;
  }

  return models.reconUser.findByPk(req.reconUser.sub);
}

router.post('/login', async (req, res) => {
  const models = req.app.locals.models;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    await logReconRequestAudit(models, req, {
      action: 'auth.login',
      outcome: 'failure',
      entityType: 'auth',
      target_identifier: email || null,
      details: { reason: 'Email and password are required' },
    });
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const user = await models.reconUser.findOne({ where: { email } });
  if (!user || !verifyPassword(password, user.password_hash)) {
    await logReconRequestAudit(models, req, {
      action: 'auth.login',
      outcome: 'failure',
      entityType: 'auth',
      target_identifier: email,
      target_name: user?.full_name || null,
      target_user_id: user?.id || null,
      details: { reason: 'Invalid email or password' },
    });
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  if (!user.active) {
    await logReconRequestAudit(models, req, {
      action: 'auth.login',
      outcome: 'failure',
      entityType: 'auth',
      ...buildTargetFromReconUser(user),
      details: { reason: 'This account is inactive' },
    });
    return res.status(403).json({ message: 'This account is inactive' });
  }

  await user.update({ last_login_at: new Date() });
  await logReconRequestAudit(models, req, {
    action: 'auth.login',
    outcome: 'success',
    entityType: 'auth',
    ...buildActorFromReconUser(user),
    ...buildTargetFromReconUser(user),
  });

  return res.json({
    success: true,
    token: createAuthToken(user),
    user: sanitizeReconUser(user),
  });
});

router.get('/me', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  const user = await models.reconUser.findByPk(req.reconUser.sub);

  if (!user || !user.active) {
    return res.status(401).json({ message: 'Session is no longer valid' });
  }

  return res.json({ success: true, user: sanitizeReconUser(user) });
});

router.get('/users', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const users = await models.reconUser.findAll({ order: [['id', 'ASC']] });
  return res.json({ success: true, users: users.map(sanitizeReconUser) });
});

router.get('/audit-logs', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;
  const where = {};

  if (req.query.action) {
    where.action = req.query.action;
  }

  if (req.query.outcome) {
    where.outcome = req.query.outcome;
  }

  if (req.query.email) {
    where[Op.or] = [
      { actor_identifier: { [Op.like]: `%${req.query.email}%` } },
      { target_identifier: { [Op.like]: `%${req.query.email}%` } },
    ];
  }

  if (req.query.startDate || req.query.endDate) {
    where.occurred_at = {};
    if (req.query.startDate) {
      where.occurred_at[Op.gte] = new Date(req.query.startDate);
    }
    if (req.query.endDate) {
      where.occurred_at[Op.lte] = new Date(req.query.endDate);
    }
  }

  const { count, rows } = await models.reconAuditLog.findAndCountAll({
    where,
    order: [['occurred_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });

  return res.json({
    success: true,
    logs: rows,
    pagination: {
      current_page: page,
      total_pages: Math.max(Math.ceil(count / limit), 1),
      total_records: count,
      per_page: limit,
    },
  });
});

router.post('/users', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const actor = await loadActorUser(req, models);
  const fullName = String(req.body?.fullName || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'finance';

  if (!fullName || !email || !password) {
    await logReconRequestAudit(models, req, {
      action: 'user.create',
      outcome: 'failure',
      entityType: 'user',
      ...buildActorFromReconUser(actor || req.reconUser),
      target_identifier: email || null,
      target_name: fullName || null,
      details: { reason: 'Full name, email, and password are required' },
    });
    return res.status(400).json({ message: 'Full name, email, and password are required' });
  }

  const existingUser = await models.reconUser.findOne({ where: { email } });
  if (existingUser) {
    await logReconRequestAudit(models, req, {
      action: 'user.create',
      outcome: 'failure',
      entityType: 'user',
      ...buildActorFromReconUser(actor || req.reconUser),
      ...buildTargetFromReconUser(existingUser),
      details: { reason: 'A user with that email already exists' },
    });
    return res.status(409).json({ message: 'A user with that email already exists' });
  }

  const user = await models.reconUser.create({
    full_name: fullName,
    email,
    password_hash: hashPassword(password),
    role,
    active: true,
  });

  await logReconRequestAudit(models, req, {
    action: 'user.create',
    outcome: 'success',
    entityType: 'user',
    ...buildActorFromReconUser(actor || req.reconUser),
    ...buildTargetFromReconUser(user),
    details: { role: user.role },
  });

  return res.status(201).json({ success: true, user: sanitizeReconUser(user) });
});

router.patch('/users/:id', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const actor = await loadActorUser(req, models);
  const user = await models.reconUser.findByPk(req.params.id);

  if (!user) {
    await logReconRequestAudit(models, req, {
      action: 'user.update',
      outcome: 'failure',
      entityType: 'user',
      ...buildActorFromReconUser(actor || req.reconUser),
      target_user_id: Number(req.params.id),
      details: { reason: 'User not found' },
    });
    return res.status(404).json({ message: 'User not found' });
  }

  const updates = {};

  if (req.body.fullName !== undefined) {
    updates.full_name = String(req.body.fullName || '').trim();
  }

  if (req.body.role !== undefined) {
    updates.role = req.body.role === 'admin' ? 'admin' : 'finance';
  }

  if (req.body.active !== undefined) {
    updates.active = Boolean(req.body.active);
  }

  if (req.body.password) {
    updates.password_hash = hashPassword(String(req.body.password));
  }

  await user.update(updates);

  await logReconRequestAudit(models, req, {
    action: 'user.update',
    outcome: 'success',
    entityType: 'user',
    ...buildActorFromReconUser(actor || req.reconUser),
    ...buildTargetFromReconUser(user),
    details: { updatedFields: Object.keys(updates) },
  });

  return res.json({ success: true, user: sanitizeReconUser(user) });
});

router.delete('/users/:id', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const actor = await loadActorUser(req, models);
  const user = await models.reconUser.findByPk(req.params.id);

  if (!user) {
    await logReconRequestAudit(models, req, {
      action: 'user.delete',
      outcome: 'failure',
      entityType: 'user',
      ...buildActorFromReconUser(actor || req.reconUser),
      target_user_id: Number(req.params.id),
      details: { reason: 'User not found' },
    });
    return res.status(404).json({ message: 'User not found' });
  }

  if (user.id === req.reconUser.sub) {
    await logReconRequestAudit(models, req, {
      action: 'user.delete',
      outcome: 'failure',
      entityType: 'user',
      ...buildActorFromReconUser(actor || req.reconUser),
      ...buildTargetFromReconUser(user),
      details: { reason: 'You cannot delete the current session user' },
    });
    return res.status(400).json({ message: 'You cannot delete the current session user' });
  }

  await user.destroy();
  await logReconRequestAudit(models, req, {
    action: 'user.delete',
    outcome: 'success',
    entityType: 'user',
    ...buildActorFromReconUser(actor || req.reconUser),
    ...buildTargetFromReconUser(user),
  });
  return res.json({ success: true });
});

module.exports = router;
