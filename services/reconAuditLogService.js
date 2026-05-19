function getRequestIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0];
  }

  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
}

function buildActorFromReconUser(currentUser) {
  if (!currentUser) {
    return {};
  }

  return {
    actor_user_id: currentUser.id || currentUser.sub || null,
    actor_identifier: currentUser.email || null,
    actor_name: currentUser.full_name || currentUser.fullName || null,
    actor_role: currentUser.role || null,
  };
}

function buildTargetFromReconUser(targetUser) {
  if (!targetUser) {
    return {};
  }

  return {
    target_user_id: targetUser.id || null,
    target_identifier: targetUser.email || null,
    target_name: targetUser.full_name || null,
  };
}

async function writeReconAuditLog(models, entry) {
  if (!models?.reconAuditLog) {
    return null;
  }

  try {
    return await models.reconAuditLog.create({
      action: entry.action,
      entity_type: entry.entityType || 'user',
      outcome: entry.outcome || 'success',
      actor_user_id: entry.actor_user_id || null,
      actor_identifier: entry.actor_identifier || null,
      actor_name: entry.actor_name || null,
      actor_role: entry.actor_role || null,
      target_user_id: entry.target_user_id || null,
      target_identifier: entry.target_identifier || null,
      target_name: entry.target_name || null,
      ip_address: entry.ip_address || null,
      user_agent: entry.user_agent || null,
      details: entry.details || null,
      occurred_at: entry.occurred_at || new Date(),
    });
  } catch (error) {
    console.error('Failed to write Central Sync audit log:', error.message);
    return null;
  }
}

async function logReconRequestAudit(models, req, entry) {
  return writeReconAuditLog(models, {
    ...entry,
    ip_address: entry.ip_address || getRequestIp(req),
    user_agent: entry.user_agent || req.headers['user-agent'] || null,
  });
}

module.exports = {
  buildActorFromReconUser,
  buildTargetFromReconUser,
  logReconRequestAudit,
  writeReconAuditLog,
};