/**
 * Reusable table + chart + stat-card primitives for pdfkit documents. Shared by
 * the Orders PDF and the Analytics PDF so both reports look like one system
 * (same header/footer/typography) instead of two hand-rolled one-offs.
 *
 * pdfkit has no built-in table widget, so this hand-rolls: column layout,
 * header row styling, zebra striping, and automatic page breaks that re-draw
 * the header on the new page. No native/canvas dependency — everything is
 * vector text + rects, safe to run on any Node host.
 */

const SVGtoPDF = require('svg-to-pdfkit');
const { PALETTE, TONE, toneForStatus, FONTS, css } = require('./exportTheme');

/**
 * Add a page break if fewer than `needed` vertical points remain before the
 * bottom margin. Absolutely-positioned draws (stat cards, charts) must call
 * this first so they neither overflow off-page nor trigger pdfkit's implicit
 * (blank-page-producing) pagination when a `text()` lands past the margin.
 */
function ensureSpace(doc, needed) {
  const maxY = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > maxY) doc.addPage();
}

// Colours resolved from the shared theme (single source of truth across Excel + PDF).
const INK_900 = css(PALETTE.ink);
const INK_500 = css(PALETTE.inkMuted);
const INK_200 = css(PALETTE.border);
const BLOOM_600 = css(PALETTE.brand);
const BLOOM_50 = css(PALETTE.brandBg);
const ZEBRA = css(PALETTE.zebra);

function money(n, currency = '') {
  const v = Number(n) || 0;
  const formatted = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/**
 * Draws a table with a repeated header row and automatic page breaks.
 *
 * @param {PDFKit.PDFDocument} doc
 * @param {{ key:string, label:string, width:number, align?:'left'|'right'|'center' }[]} columns
 * @param {Array<Record<string,string>>} rows — already-formatted string cells
 * @param {{ startY?: number, rowHeight?: number, onPageBreak?: (doc:PDFKit.PDFDocument)=>number }} opts
 * @returns {number} the Y position after the table
 */
function drawTable(doc, columns, rows, opts = {}) {
  const rowHeight = opts.rowHeight ?? 22;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function drawHeader(y) {
    doc.rect(left, y, right - left, rowHeight).fill(BLOOM_600);
    doc.fillColor(css(PALETTE.white)).font(FONTS.bold).fontSize(9);
    let x = left;
    for (const col of columns) {
      doc.text(col.label, x + 6, y + 6, { width: col.width - 12, align: col.align ?? 'left' });
      x += col.width;
    }
    return y + rowHeight;
  }

  let y = opts.startY ?? doc.y;
  // Guard the header's own placement the same way each data row already is
  // below — without this, a header drawn too close to the bottom margin gets
  // every one of its per-column text() calls implicitly repaginated by
  // pdfkit (explicit x/y coordinates don't exempt a call from its overflow
  // check, and the stale absolute y stays "past the bottom" on every
  // subsequent page too), producing one spurious extra page per column.
  if (y + rowHeight > bottomLimit) {
    doc.addPage();
    y = opts.onPageBreak ? opts.onPageBreak(doc) : doc.page.margins.top;
  }
  y = drawHeader(y);

  rows.forEach((row, i) => {
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = opts.onPageBreak ? opts.onPageBreak(doc) : doc.page.margins.top;
      y = drawHeader(y);
    }
    if (i % 2 === 1) {
      doc.rect(left, y, right - left, rowHeight).fill(ZEBRA);
    }
    doc.font(FONTS.base).fontSize(9);
    let x = left;
    for (const col of columns) {
      const val = row[col.key] ?? '';
      // Conditional formatting: colour the status column's text by tone
      // (COMPLETED green, PENDING_PAYMENT yellow, CANCELLED/FAILED red, …) when the caller
      // marks which column holds the status.
      if (opts.statusKey && col.key === opts.statusKey) {
        const tone = TONE[toneForStatus(String(val))];
        doc.fillColor(tone ? css(tone.text) : INK_900).font(FONTS.bold);
      } else {
        doc.fillColor(INK_900).font(FONTS.base);
      }
      doc.text(String(val), x + 6, y + 6, { width: col.width - 12, align: col.align ?? 'left' });
      x += col.width;
    }
    doc.strokeColor(INK_200).lineWidth(0.5)
      .moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();
    y += rowHeight;
  });

  doc.y = y + 12;
  return doc.y;
}

/** A KPI stat card: bordered rounded box with a big number and a label underneath. */
function drawStatCard(doc, x, y, w, h, label, value) {
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(BLOOM_50, INK_200);
  doc.fillColor(BLOOM_600).font(FONTS.bold).fontSize(16)
    .text(value, x + 12, y + 12, { width: w - 24 });
  doc.fillColor(INK_500).font(FONTS.base).fontSize(8)
    .text(label, x + 12, y + h - 24, { width: w - 24 });
}

/** Lays out N stat cards evenly across the content width. */
function drawStatCardRow(doc, cards, opts = {}) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const gap = 12;
  const h = opts.height ?? 64;
  const w = (right - left - gap * (cards.length - 1)) / cards.length;
  if (opts.y == null) ensureSpace(doc, h + 16);
  const y = opts.y ?? doc.y;
  cards.forEach((c, i) => drawStatCard(doc, left + i * (w + gap), y, w, h, c.label, c.value));
  doc.y = y + h + 16;
  return doc.y;
}

/** A simple vertical-bar chart drawn with pdfkit primitives — no canvas/image dependency. */
function drawBarChart(doc, { title, points, valueFormatter = (v) => String(v) }, opts = {}) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const chartW = right - left;
  const chartH = opts.height ?? 140;
  const labelBand = points.length <= 16 ? 22 : 8;

  // Reserve the whole chart (title + plot + labels) up front so it never spills
  // off the page or triggers implicit pagination mid-draw.
  if (opts.y == null) ensureSpace(doc, (title ? 20 : 0) + chartH + labelBand);
  const y0 = opts.y ?? doc.y;

  if (title) {
    doc.fillColor(INK_900).font(FONTS.bold).fontSize(11).text(title, left, y0, { lineBreak: false });
  }
  const chartTop = y0 + (title ? 20 : 0);
  const axisY = chartTop + chartH;
  const max = Math.max(1, ...points.map((p) => p.value));
  const barGap = 6;
  const barW = Math.max(2, (chartW - barGap * (points.length - 1)) / points.length);

  doc.strokeColor(INK_200).lineWidth(1).moveTo(left, axisY).lineTo(right, axisY).stroke();

  points.forEach((p, i) => {
    const barH = Math.round((p.value / max) * (chartH - 18));
    const x = left + i * (barW + barGap);
    doc.rect(x, axisY - barH, barW, barH).fill(BLOOM_600);
    if (points.length <= 16) {
      // lineBreak:false + height keep the label a single clipped line so a long
      // category name can never wrap and push pdfkit into adding a page.
      doc.fillColor(INK_500).font(FONTS.base).fontSize(7)
        .text(p.label, x - 2, axisY + 4, { width: barW + 4, align: 'center', lineBreak: false, height: 10, ellipsis: true });
    }
  });
  doc.fillColor(INK_500).font(FONTS.base).fontSize(8)
    .text(valueFormatter(max), left, chartTop - 2, { width: 120, lineBreak: false });

  doc.y = axisY + labelBand;
  return doc.y;
}

/** Standard report header: logo (if fetchable) + title + generated-at + filters line. */
async function drawReportHeader(doc, { logoSvg, logoBuffer, siteName, title, generatedAt, filterLines = [] }) {
  const left = doc.page.margins.left;
  let brandRendered = false;

  // Preferred branding: the bundled SVG logo (mark + wordmark) via svg-to-pdfkit.
  if (logoSvg) {
    try {
      const logoWidth = 172;
      const logoHeight = logoWidth * (146.2 / 758); // preserve the asset's aspect ratio
      SVGtoPDF(doc, logoSvg, left, doc.y, { width: logoWidth, height: logoHeight, assumePt: true });
      doc.y += logoHeight + 12;
      brandRendered = true;
    } catch {
      // SVG parse/render issue — fall back to a raster logo or the wordmark text.
    }
  }
  // Fallback 1: an admin-uploaded raster logo (png/jpeg) from Settings.
  if (!brandRendered && logoBuffer) {
    try {
      doc.image(logoBuffer, left, doc.y, { height: 34 });
      doc.y += 42;
      brandRendered = true;
    } catch {
      // Unsupported raster (e.g. webp) — fall through to text.
    }
  }
  // Fallback 2: the store name as text.
  if (!brandRendered) {
    doc.fillColor(PALETTE ? css(PALETTE.brand) : '#b6436a').font(FONTS.bold).fontSize(15).text(siteName, left, doc.y);
    doc.moveDown(0.4);
  }

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fillColor(INK_900).font(FONTS.bold).fontSize(20).text(title, left, doc.y);
  doc.moveDown(0.3);
  // Each meta line on its own row — the header sits at the top of a fresh page
  // so normal line-breaking is safe here (no spurious-pagination risk).
  doc.fillColor(INK_500).font(FONTS.base).fontSize(9)
    .text(`Generated ${generatedAt}`, { width: contentWidth });
  filterLines.forEach((line) => doc.text(line, { width: contentWidth }));
  doc.moveDown(1);
  doc.strokeColor(INK_200).lineWidth(1).moveTo(left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(1);
}

/** Adds "Page X of Y" + a branding line to every buffered page. Call once, right before doc.end(). */
function addPageFooters(doc, { siteName }) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing near the page bottom must NOT trigger pdfkit's auto-pagination —
    // otherwise each footer text() appends a blank page (the root cause of the
    // empty-page bug). Zeroing the bottom margin + lineBreak:false disables it.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 26;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    doc.fillColor(INK_500).font(FONTS.base).fontSize(8);
    doc.text(siteName, left, y, { width: (right - left) / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left, y, { width: right - left, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

module.exports = {
  money,
  drawTable,
  drawStatCard,
  drawStatCardRow,
  drawBarChart,
  drawReportHeader,
  addPageFooters,
  FONTS,
  COLORS: { INK_900, INK_500, INK_200, BLOOM_600, BLOOM_50, ZEBRA },
};
