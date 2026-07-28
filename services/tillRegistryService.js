const nodemailer = require('nodemailer');

function normalizeTillValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function getTillIdentityFromPayload(eventBodyOrPayload) {
  const payload = eventBodyOrPayload?.payload && typeof eventBodyOrPayload.payload === 'object'
    ? eventBodyOrPayload.payload
    : eventBodyOrPayload || {};

  return {
    branchId: normalizeTillValue(payload.branch_id),
    terminalId: normalizeTillValue(payload.terminal_id || payload.branch_id),
  };
}

function serializeKnownTill(till, dayStart = null, dayEnd = null) {
  const plain = till.toJSON ? till.toJSON() : till;
  const lastSyncAt = plain.last_sync_at ? new Date(plain.last_sync_at) : null;
  const sentToday = Boolean(
    dayStart
    && dayEnd
    && lastSyncAt
    && lastSyncAt >= dayStart
    && lastSyncAt < dayEnd
  );

  return {
    id: plain.id,
    key: `${plain.branch_id}:${plain.terminal_id}`,
    branchId: plain.branch_id,
    terminalId: plain.terminal_id,
    terminalName: plain.terminal_name || `Terminal ${plain.terminal_id}`,
    storeId: plain.store_id,
    source: plain.source,
    active: Boolean(plain.active),
    sentToday,
    lastReceivedAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    lastSyncEventId: plain.last_sync_event_id,
    lastEventType: plain.last_event_type,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function registerTillFromSyncEvent(models, syncEvent, options = {}) {
  const identity = getTillIdentityFromPayload(syncEvent?.payload || {});
  if (!identity.branchId || !identity.terminalId) {
    return null;
  }

  const now = options.now || new Date();
  const storeId = syncEvent.store_id == null ? null : Number(syncEvent.store_id);
  const [till, created] = await models.knownTill.findOrCreate({
    where: {
      branch_id: identity.branchId,
      terminal_id: identity.terminalId,
    },
    defaults: {
      branch_id: identity.branchId,
      terminal_id: identity.terminalId,
      store_id: Number.isFinite(storeId) ? storeId : null,
      terminal_name: null,
      source: 'sync',
      active: true,
      last_sync_at: now,
      last_sync_event_id: syncEvent.id || null,
      last_event_type: syncEvent.event_type || null,
    },
    transaction: options.transaction,
  });

  const updates = {
    active: true,
    last_sync_at: now,
    last_sync_event_id: syncEvent.id || null,
    last_event_type: syncEvent.event_type || null,
  };

  if (Number.isFinite(storeId)) {
    updates.store_id = storeId;
  }

  if (!created && till.source !== 'manual') {
    updates.source = 'sync';
  }

  await till.update(updates, { transaction: options.transaction });
  return till;
}

function buildTodayWindow(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function getTillSyncStatus(models, options = {}) {
  const { start, end } = buildTodayWindow(options.now);
  const tills = await models.knownTill.findAll({
    where: options.includeInactive ? undefined : { active: true },
    order: [
      ['branch_id', 'ASC'],
      ['terminal_id', 'ASC'],
    ],
  });
  const terminals = tills
    .map((till) => serializeKnownTill(till, start, end))
    .sort((left, right) => {
      if (left.sentToday !== right.sentToday) return left.sentToday ? 1 : -1;
      const branchCompare = left.branchId.localeCompare(right.branchId, undefined, { numeric: true });
      if (branchCompare !== 0) return branchCompare;
      return left.terminalId.localeCompare(right.terminalId, undefined, { numeric: true });
    });
  const syncedCount = terminals.filter((terminal) => terminal.sentToday).length;

  return {
    generatedAt: new Date().toISOString(),
    day: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    summary: {
      totalTerminals: terminals.length,
      syncedCount,
      missingCount: terminals.length - syncedCount,
    },
    terminals,
  };
}

function parseEmailList(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const host = String(process.env.SMTP_HOST || '').trim();
  const from = String(process.env.TILL_REPORT_SMTP_FROM || process.env.SMTP_FROM || user).trim();
  if (!host || !user || !pass || !from || !Number.isFinite(port)) {
    const error = new Error('Till status email is not configured');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }
  return { host, port, user, pass, from };
}

function getTillReportRecipients() {
  return parseEmailList(process.env.TILL_STATUS_EMAIL_RECIPIENTS || process.env.TILL_REPORT_RECIPIENTS);
}

function formatReportLine(terminal) {
  const lastSeen = terminal.lastReceivedAt
    ? new Date(terminal.lastReceivedAt).toLocaleString('en-GB')
    : 'Never';
  return `${terminal.branchId}\t${terminal.terminalId}\t${terminal.terminalName}\t${terminal.sentToday ? 'SENDING' : 'NOT SENDING'}\t${lastSeen}`;
}

function buildTillStatusEmail(status) {
  const company = String(process.env.COMPANY_NAME || 'SwiftCart').trim();
  const dateLabel = new Date(status.generatedAt).toLocaleDateString('en-GB');
  const sending = status.terminals.filter((terminal) => terminal.sentToday);
  const missing = status.terminals.filter((terminal) => !terminal.sentToday);
  const rows = status.terminals.map(formatReportLine).join('\n') || 'No tills configured.';

  return {
    subject: `${company} till sync status - ${dateLabel}`,
    text: [
      `${company} till sync status for ${dateLabel}`,
      '',
      `Known tills: ${status.summary.totalTerminals}`,
      `Sending today: ${status.summary.syncedCount}`,
      `Not sending today: ${status.summary.missingCount}`,
      '',
      'Branch\tTerminal\tName\tStatus\tLast received',
      rows,
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a">
        <h2>${company} till sync status - ${dateLabel}</h2>
        <p><strong>${status.summary.syncedCount}</strong> sending today, <strong>${status.summary.missingCount}</strong> not sending, out of <strong>${status.summary.totalTerminals}</strong> known tills.</p>
        <h3>Not sending</h3>
        ${buildHtmlTable(missing)}
        <h3>Sending</h3>
        ${buildHtmlTable(sending)}
      </div>
    `,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtmlTable(terminals) {
  if (terminals.length === 0) {
    return '<p>None.</p>';
  }

  const rows = terminals.map((terminal) => `
    <tr>
      <td>${escapeHtml(terminal.branchId)}</td>
      <td>${escapeHtml(terminal.terminalId)}</td>
      <td>${escapeHtml(terminal.terminalName)}</td>
      <td>${terminal.lastReceivedAt ? escapeHtml(new Date(terminal.lastReceivedAt).toLocaleString('en-GB')) : 'Never'}</td>
    </tr>
  `).join('');

  return `
    <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1">
      <thead>
        <tr style="background:#f8fafc">
          <th align="left">Branch</th>
          <th align="left">Terminal</th>
          <th align="left">Name</th>
          <th align="left">Last received</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function sendTillStatusEmail(models) {
  const recipients = getTillReportRecipients();
  if (recipients.length === 0) {
    return { sent: false, reason: 'NO_RECIPIENTS' };
  }

  const config = smtpConfig();
  const status = await getTillSyncStatus(models);
  const message = buildTillStatusEmail(status);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || config.port === 465,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' },
  });

  await transporter.sendMail({
    from: config.from,
    to: recipients,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  return { sent: true, recipients, summary: status.summary };
}

module.exports = {
  getTillIdentityFromPayload,
  getTillReportRecipients,
  getTillSyncStatus,
  registerTillFromSyncEvent,
  sendTillStatusEmail,
  serializeKnownTill,
};
