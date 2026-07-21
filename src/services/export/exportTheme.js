/**
 * Centralized export styling — the SINGLE source of truth for colours, fonts,
 * number/date formats and layout used by BOTH the Excel (excelStyle.util.js)
 * and PDF (pdfTable.util.js) renderers, for BOTH the Orders and Analytics
 * reports. Renderers must import values from here rather than hardcoding hex
 * codes / formats so every generated report stays visually consistent and a
 * future rebrand is a one-file change.
 *
 * Colours are stored as 6-digit hex WITHOUT a prefix. ExcelJS wants ARGB
 * ("FF" + hex); pdfkit wants CSS ("#" + hex). Use argb()/css() to convert.
 */

const PALETTE = {
  brand: 'B6436A', // bloom-600
  brandDark: '8E2F4F',
  brandBg: 'FDF1F4', // bloom-50 — light brand wash for cards/title band
  ink: '1F2430', // ink-900 (primary text)
  inkMuted: '6B7280', // ink-500 (secondary text)
  border: 'E5E7EB', // ink-200
  zebra: 'F9FAFB', // alternating row fill
  white: 'FFFFFF',

  // Semantic status tones — a light background + a readable dark text per tone.
  greenBg: 'DCFCE7',
  greenText: '166534',
  yellowBg: 'FEF9C3',
  yellowText: '854D0E',
  redBg: 'FEE2E2',
  redText: '991B1B',
  blueBg: 'DBEAFE',
  blueText: '1E40AF',
  grayBg: 'F3F4F6',
  grayText: '374151',
};

const TONE = {
  green: { bg: PALETTE.greenBg, text: PALETTE.greenText },
  yellow: { bg: PALETTE.yellowBg, text: PALETTE.yellowText },
  red: { bg: PALETTE.redBg, text: PALETTE.redText },
  blue: { bg: PALETTE.blueBg, text: PALETTE.blueText },
  gray: { bg: PALETTE.grayBg, text: PALETTE.grayText },
};

// Order/payment status → semantic tone (drives conditional formatting).
// COMPLETED=green, PROCESSING=blue, PENDING_PAYMENT=yellow, CANCELLED/FAILED=red,
// ON_HOLD/REFUNDED/DRAFT=gray (paused/settled-elsewhere/not-yet-real, kept visually calm).
const ORDER_STATUS_TONE = {
  PENDING_PAYMENT: 'yellow',
  PROCESSING: 'blue',
  ON_HOLD: 'gray',
  COMPLETED: 'green',
  CANCELLED: 'red',
  REFUNDED: 'gray',
  FAILED: 'red',
  DRAFT: 'gray',
};

const PAYMENT_STATUS_TONE = {
  PAID: 'green',
  UNPAID: 'yellow',
  FAILED: 'red',
};

/** Resolve a tone name for any order/payment status value (gray fallback). */
function toneForStatus(value) {
  return ORDER_STATUS_TONE[value] || PAYMENT_STATUS_TONE[value] || 'gray';
}

const FONTS = {
  // pdfkit ships these standard fonts with no external files (safe on slim images).
  base: 'Helvetica',
  bold: 'Helvetica-Bold',
};

const FORMATS = {
  currency: '#,##0.00',
  currencyWithSymbol: '#,##0.00', // symbol lives in a separate Currency column
  integer: '#,##0',
  percent: '0.0%',
  date: 'yyyy-mm-dd hh:mm',
  dateOnly: 'yyyy-mm-dd',
};

const LAYOUT = {
  excel: {
    maxColWidth: 50,
    minColWidth: 12,
    titleRowHeight: 24,
  },
  pdf: {
    margin: 36,
    rowHeight: 22,
    statCardHeight: 64,
    chartHeight: 140,
  },
};

const argb = (hex) => `FF${hex}`;
const css = (hex) => `#${hex}`;

module.exports = {
  PALETTE,
  TONE,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_TONE,
  toneForStatus,
  FONTS,
  FORMATS,
  LAYOUT,
  argb,
  css,
};
