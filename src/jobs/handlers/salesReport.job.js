/**
 * Scheduled sales reports emailed to every active ADMIN:
 *   report.weekly  — Mondays 06:00, covering the last completed week (Mon–Sun)
 *   report.monthly — 1st of month 06:00, covering the last completed calendar month
 *
 * Both fire in JOBS_TIMEZONE (default Asia/Dubai). Each report includes revenue, orders,
 * units sold, AOV, customers, a status breakdown, top categories, and % change vs the
 * prior equal period — so an admin can gauge last week/month at a glance from the inbox.
 *
 * Exports an ARRAY of job defs (src/jobs/index.js flattens arrays).
 */

const { enqueue } = require('../queue');
const { QUEUES } = require('../queues');
const reportService = require('../../services/report.service');
const templates = require('../../emails/templates');

async function sendReport(report) {
  const recipients = await reportService.getAdminRecipients();
  if (recipients.length === 0) {
    console.warn(`[jobs] ${report.title}: no admin recipients/CONTACT_EMAIL set; skipping`);
    return { emailed: 0 };
  }

  const html = templates.renderSalesReport(report);
  const subject = `Amoon Bloom — ${report.title} (${report.periodLabel})`;

  await Promise.all(
    recipients.map((to) => enqueue(QUEUES.EMAIL_SEND, { to, subject, html }))
  );

  console.log(`[jobs] ${report.title} emailed=${recipients.length} period="${report.periodLabel}"`);
  return { emailed: recipients.length };
}

async function handleWeekly() {
  const report = await reportService.buildWeeklyReport();
  return sendReport(report);
}

async function handleMonthly() {
  const report = await reportService.buildMonthlyReport();
  return sendReport(report);
}

module.exports = [
  {
    queue: QUEUES.REPORT_WEEKLY,
    handler: handleWeekly,
    cron: process.env.REPORT_WEEKLY_CRON || '0 6 * * 1', // Mondays 06:00 (JOBS_TIMEZONE)
    options: { retryLimit: 0 },
  },
  {
    queue: QUEUES.REPORT_MONTHLY,
    handler: handleMonthly,
    cron: process.env.REPORT_MONTHLY_CRON || '0 6 1 * *', // 1st of month 06:00 (JOBS_TIMEZONE)
    options: { retryLimit: 0 },
  },
];
