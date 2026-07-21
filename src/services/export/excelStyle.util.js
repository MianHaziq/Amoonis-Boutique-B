/**
 * Shared ExcelJS styling helpers so the Orders and Analytics workbooks look
 * like one system. All colours/fonts/formats come from exportTheme.js — no hex
 * codes are hardcoded here — so a rebrand is a one-file change.
 *
 * Tables are written at ABSOLUTE row positions (not via `sheet.columns = …`,
 * which is global and misaligns once a branded title block or a second stacked
 * table precedes them), so a single sheet can hold a title band + several
 * tables and still keep correct widths, borders and frozen panes.
 */

const { PALETTE, TONE, toneForStatus, FORMATS, LAYOUT, argb } = require('./exportTheme');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.brand) } };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.zebra) } };
const TITLE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.brandBg) } };
const THIN_BORDER = { style: 'thin', color: { argb: argb(PALETTE.border) } };
const ALL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

// ExcelJS embeds png/jpeg/gif only — the store logo may be webp, which it can't
// embed. Best-effort: embed when the format is supported, else fall back to the
// store-name text (same graceful degradation as the PDF header).
const EXCEL_IMAGE_EXT = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif' };

/**
 * Branded title band at the top of a sheet: optional logo, store name, report
 * title, generated timestamp, applied filters and currency — in a merged,
 * shaded band. Returns the next free (1-based) row so the caller can place its
 * table beneath it.
 *
 * @param {import('exceljs').Workbook} workbook
 * @param {import('exceljs').Worksheet} sheet
 */
function writeTitleBlock(workbook, sheet, opts) {
  const { siteName, title, generatedAt, currency, filterLines = [], logo, columnSpan = 6 } = opts;
  const lastCol = String.fromCharCode(64 + Math.max(3, columnSpan)); // e.g. 6 -> 'F'

  const lines = [
    { text: siteName, font: { bold: true, size: 12, color: { argb: argb(PALETTE.brand) } } },
    { text: title, font: { bold: true, size: 16, color: { argb: argb(PALETTE.ink) } } },
    { text: `Generated: ${generatedAt}`, font: { size: 9, color: { argb: argb(PALETTE.inkMuted) } } },
    ...(currency ? [{ text: `Currency: ${currency}`, font: { size: 9, color: { argb: argb(PALETTE.inkMuted) } } }] : []),
    ...filterLines.map((line) => ({ text: line, font: { size: 9, color: { argb: argb(PALETTE.inkMuted) } } })),
  ];

  let row = 1;
  for (const line of lines) {
    sheet.mergeCells(`A${row}:${lastCol}${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = line.text;
    cell.font = line.font;
    cell.fill = TITLE_FILL;
    cell.alignment = { vertical: 'middle', horizontal: logo ? 'left' : 'left', indent: 1 };
    sheet.getRow(row).height = LAYOUT.excel.titleRowHeight;
    row += 1;
  }

  // Optional logo, anchored over the title band on the right.
  if (logo?.buffer && EXCEL_IMAGE_EXT[logo.extension]) {
    try {
      const imageId = workbook.addImage({ buffer: logo.buffer, extension: EXCEL_IMAGE_EXT[logo.extension] });
      sheet.addImage(imageId, {
        tl: { col: columnSpan - 1.6, row: 0.15 },
        ext: { width: 120, height: 40 },
      });
    } catch {
      // Unsupported/corrupt image — the store-name text line already covers branding.
    }
  }

  return row + 1; // one blank spacer row
}

/**
 * Writes a header row + data rows at an absolute position (appends to the sheet
 * by default). Frozen header (when it's the first table), bold white-on-brand
 * header, zebra striping, borders, per-cell number formats, capped auto-width.
 *
 * @returns {{ headerRowNumber:number, firstDataRow:number, lastDataRow:number }}
 */
function writeStyledTable(sheet, columns, rows, opts = {}) {
  const headerRowNumber = opts.startRow ?? sheet.rowCount + 1;

  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: argb(PALETTE.white) } };
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
    cell.alignment = { vertical: 'middle' };
  });

  rows.forEach((row, i) => {
    const excelRow = sheet.getRow(headerRowNumber + 1 + i);
    columns.forEach((c, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = row[c.key] ?? null;
      cell.border = ALL_BORDERS;
      if (i % 2 === 1) cell.fill = ZEBRA_FILL;
      if (c.numFmt) cell.numFmt = c.numFmt;
    });
  });

  // Column widths: honour an explicit width, else auto-size to the widest cell,
  // capped. Never shrink a column another stacked table already widened.
  columns.forEach((col, idx) => {
    const sheetCol = sheet.getColumn(idx + 1);
    const contentLengths = rows.map((r) => String(r[col.key] ?? '').length);
    const widest = Math.max(col.header.length, ...contentLengths, 0);
    const w = col.width ?? Math.min(LAYOUT.excel.maxColWidth, Math.max(LAYOUT.excel.minColWidth, widest + 3));
    if (!sheetCol.width || w > sheetCol.width) sheetCol.width = w;
  });

  const freeze = opts.freeze ?? headerRowNumber === 1;
  if (freeze) sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  return { headerRowNumber, firstDataRow: headerRowNumber + 1, lastDataRow: headerRowNumber + rows.length };
}

/** Adds a `=SUM(range)` formula row under numeric columns — real Excel formulas. */
function addSumFormulaRow(sheet, columns, { firstDataRow, lastDataRow }, sumKeys, labelKey) {
  if (lastDataRow < firstDataRow) return;
  const rowValues = columns.map((c) => {
    if (c.key === labelKey) return 'TOTAL';
    if (!sumKeys.includes(c.key)) return null;
    const colLetter = sheet.getColumn(columns.findIndex((x) => x.key === c.key) + 1).letter;
    return { formula: `SUM(${colLetter}${firstDataRow}:${colLetter}${lastDataRow})` };
  });
  const totalRow = sheet.addRow(rowValues);
  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = ALL_BORDERS;
  });
  // Re-apply number formats (addRow doesn't carry per-column numFmt here).
  columns.forEach((c, idx) => {
    if (c.numFmt) totalRow.getCell(idx + 1).numFmt = c.numFmt;
  });
}

/**
 * Conditional formatting: colour the status cell of every data row by semantic
 * tone (COMPLETED green, PENDING_PAYMENT yellow, CANCELLED/FAILED red, …). Done as concrete
 * per-cell fills (not ExcelJS rule objects) so it renders identically in Excel,
 * Google Sheets and LibreOffice.
 */
function applyStatusColors(sheet, { firstDataRow, lastDataRow }, statusColIndex) {
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    const cell = sheet.getRow(r).getCell(statusColIndex);
    const tone = TONE[toneForStatus(String(cell.value ?? ''))];
    if (!tone) continue;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(tone.bg) } };
    cell.font = { bold: true, color: { argb: argb(tone.text) } };
    cell.alignment = { vertical: 'middle' };
  }
}

/**
 * Applies a per-row number format to a single column of a just-written table
 * (used for a Summary "Value" column that mixes currency / integer / percent).
 * `formats[i]` aligns with data row i; pass null to leave a row unformatted.
 */
function applyValueFormats(sheet, { firstDataRow }, valueColIndex, formats) {
  formats.forEach((fmt, i) => {
    if (fmt) sheet.getRow(firstDataRow + i).getCell(valueColIndex).numFmt = fmt;
  });
}

module.exports = {
  writeTitleBlock,
  writeStyledTable,
  addSumFormulaRow,
  applyStatusColors,
  applyValueFormats,
  CURRENCY_FMT: FORMATS.currency,
  DATE_FMT: FORMATS.date,
  INTEGER_FMT: FORMATS.integer,
  PERCENT_FMT: '#,##0.00" %"',
  DECIMAL_FMT: '#,##0.00',
};
