/**
 * Verification harness for the new email-reports module. Exercises every NEW code path
 * against the real DB but NEVER calls emailService.deliver (no real emails are sent).
 * Run: node scripts/reports-verify.js
 */
require('dotenv').config();

const prisma = require('../src/config/db');
const reportService = require('../src/services/report.service');
const templates = require('../src/emails/templates');

const fs = require('fs');
const OUT = require('path').join(__dirname, '..', '.report-previews');

let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
function isHtml(s) {
  return typeof s === 'string' && s.startsWith('<!DOCTYPE html>') && s.includes('</html>') && !s.includes('undefined');
}

(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });

    // 1) DB connectivity
    await prisma.$queryRaw`SELECT 1`;
    ok('DB reachable', true);

    // 2) Recipients
    const recipients = await reportService.getAdminRecipients();
    ok('getAdminRecipients returns array', Array.isArray(recipients), `${recipients.length} recipient(s): ${recipients.join(', ') || '(none — would fall back/skip)'}`);

    // 3) Stock report (real query + render)
    const stock = await reportService.buildStockReport();
    ok('buildStockReport shape', stock && typeof stock.threshold === 'number' && Array.isArray(stock.products), `threshold=${stock.threshold}, ${stock.products.length} low`);
    const stockHtml = templates.renderStockReport(stock);
    ok('renderStockReport → valid HTML', isHtml(stockHtml), `${stockHtml.length} chars`);
    fs.writeFileSync(`${OUT}/stock.html`, stockHtml);

    // 4) Weekly report (real analytics getKpiAnalytics + getCategorySalesAnalytics)
    const weekly = await reportService.buildWeeklyReport();
    ok('buildWeeklyReport: current totals present', weekly.current && typeof weekly.current.netRevenue !== 'undefined',
      `rev=${weekly.current.netRevenue} ${weekly.currency}, orders=${weekly.current.netSalesCount}, units=${weekly.current.unitsSold}, period="${weekly.periodLabel}"`);
    ok('buildWeeklyReport: deltas computed', weekly.deltas && Object.prototype.hasOwnProperty.call(weekly.deltas, 'netRevenue'),
      `revΔ=${weekly.deltas.netRevenue == null ? 'new' : weekly.deltas.netRevenue.toFixed(1) + '%'}`);
    ok('buildWeeklyReport: byStatus present', weekly.byStatus && typeof weekly.byStatus === 'object');
    ok('buildWeeklyReport: topCategories is array', Array.isArray(weekly.topCategories), `${weekly.topCategories.length} cat(s)`);
    const weeklyHtml = templates.renderSalesReport(weekly);
    ok('renderSalesReport (weekly) → valid HTML', isHtml(weeklyHtml), `${weeklyHtml.length} chars`);
    fs.writeFileSync(`${OUT}/weekly.html`, weeklyHtml);

    // 5) Monthly report
    const monthly = await reportService.buildMonthlyReport();
    ok('buildMonthlyReport: totals present', monthly.current && typeof monthly.current.netRevenue !== 'undefined',
      `rev=${monthly.current.netRevenue} ${monthly.currency}, period="${monthly.periodLabel}"`);
    const monthlyHtml = templates.renderSalesReport(monthly);
    ok('renderSalesReport (monthly) → valid HTML', isHtml(monthlyHtml), `${monthlyHtml.length} chars`);
    fs.writeFileSync(`${OUT}/monthly.html`, monthlyHtml);

    // 6) Order confirmation: replicate email.job's load + render on a REAL order (no send)
    const someOrder = await prisma.order.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (someOrder) {
      const order = await prisma.order.findUnique({
        where: { id: someOrder.id },
        include: { items: { select: { productTitle: true, quantity: true, price: true } } },
      });
      const settings = await prisma.settings.findUnique({ where: { id: 'default' }, select: { currency: true } }).catch(() => null);
      order.currency = settings?.currency || 'AED';
      const ocHtml = templates.renderOrderConfirmation(order);
      ok('renderOrderConfirmation (real order) → valid HTML', isHtml(ocHtml),
        `order #${order.orderNumber}, ${order.items.length} item(s), ${order.paymentStatus}/${order.paymentMethod}`);
      fs.writeFileSync(`${OUT}/order-confirmation.html`, ocHtml);
    } else {
      ok('order-confirmation skipped (no orders in DB)', true);
    }

    console.log(`\nPreviews written to ${OUT}/`);
    console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED — no errors.' : `\n⚠️  ${failures} check(s) FAILED.`);
  } catch (err) {
    console.error('\n❌ THREW:', err);
    failures++;
  } finally {
    await prisma.$disconnect().catch(() => {});
    process.exit(failures === 0 ? 0 : 1);
  }
})();
