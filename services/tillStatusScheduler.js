const { sendTillStatusEmail } = require('./tillRegistryService');

const DEFAULT_REPORT_TIME = '20:00';

function parseReportTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || DEFAULT_REPORT_TIME).trim());
  if (!match) {
    return { hour: 20, minute: 0 };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 20, minute: 0 };
  }

  return { hour, minute };
}

function nextRunDate(now = new Date(), timeValue = process.env.TILL_STATUS_REPORT_TIME) {
  const { hour, minute } = parseReportTime(timeValue);
  const runAt = new Date(now);
  runAt.setHours(hour, minute, 0, 0);

  if (runAt <= now) {
    runAt.setDate(runAt.getDate() + 1);
  }

  return runAt;
}

function startTillStatusScheduler(models) {
  if (String(process.env.TILL_STATUS_REPORT_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[tillStatus] daily report scheduler disabled');
    return { stop() {} };
  }

  let timer = null;
  let stopped = false;

  async function runReport() {
    if (stopped) return;

    try {
      const result = await sendTillStatusEmail(models);
      if (result.sent) {
        console.log(`[tillStatus] sent daily report to ${result.recipients.join(', ')}`);
      } else {
        console.warn(`[tillStatus] skipped daily report: ${result.reason}`);
      }
    } catch (error) {
      console.error('[tillStatus] failed to send daily report:', error.message);
    } finally {
      scheduleNext();
    }
  }

  function scheduleNext() {
    if (stopped) return;

    const runAt = nextRunDate();
    const delayMs = Math.max(runAt.getTime() - Date.now(), 1000);
    timer = setTimeout(runReport, delayMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    console.log(`[tillStatus] next daily report scheduled for ${runAt.toString()}`);
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  nextRunDate,
  parseReportTime,
  startTillStatusScheduler,
};
