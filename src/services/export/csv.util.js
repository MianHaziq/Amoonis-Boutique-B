/**
 * Minimal RFC-4180 CSV builder shared by the Orders and Analytics CSV
 * renderers. Supports multiple labelled "sections" in one file (a section
 * title line, a header row, then data rows, separated by a blank line) so a
 * multi-table report (Analytics) or an orders+items report can live in a
 * single CSV that still opens cleanly in Excel / Google Sheets / LibreOffice.
 *
 * A leading UTF-8 BOM is emitted so Excel on Windows renders non-ASCII
 * (Arabic product titles, currency) correctly instead of mojibake.
 */

const BOM = '﻿';

/** Quote a single cell per RFC-4180 (wrap in quotes + double interior quotes). */
function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToLine(cells) {
  return cells.map(csvCell).join(',');
}

/**
 * @param {Array<{ title?: string, columns: {key:string,header:string}[], rows: object[] }>} sections
 * @returns {string} CSV text (with BOM)
 */
function buildCsv(sections) {
  const blocks = [];
  for (const section of sections) {
    const lines = [];
    if (section.title) lines.push(rowToLine([section.title]));
    lines.push(rowToLine(section.columns.map((c) => c.header)));
    for (const row of section.rows) {
      lines.push(rowToLine(section.columns.map((c) => row[c.key])));
    }
    blocks.push(lines.join('\r\n'));
  }
  // Blank line between sections.
  return BOM + blocks.join('\r\n\r\n') + '\r\n';
}

/** Convenience for a plain key/value section (e.g. a summary block). */
function keyValueSection(title, pairs) {
  return {
    title,
    columns: [
      { key: 'metric', header: 'Metric' },
      { key: 'value', header: 'Value' },
    ],
    rows: pairs.map(([metric, value]) => ({ metric, value })),
  };
}

module.exports = { buildCsv, keyValueSection, csvCell };
