// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — CSV utilities
//
// Defends against CSV / spreadsheet formula injection (CVE-class).
// Excel / Google Sheets / LibreOffice will evaluate any cell that
// begins with `=`, `+`, `-`, `@`, TAB or CR as a formula — which is
// a known data-exfiltration vector when a user opens an exported
// CSV containing attacker-controlled text (e.g. student names).
//
//   escapeCsvField  — safe per-cell encoder
//   csvRow          — encodes an array of cells into a CSV line
//   csvFilename     — strips path/CRLF/special chars from filenames
// ═══════════════════════════════════════════════════════════════

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCsvField(value) {
    if (value === null || value === undefined) return '';

    let text;
    if (value instanceof Date) {
        text = value.toISOString();
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        text = String(value);
    } else if (typeof value === 'object') {
        try { text = JSON.stringify(value); } catch { text = String(value); }
    } else {
        text = String(value);
    }

    // Strip NUL bytes — Excel chokes; some CSV parsers truncate.
    text = text.replace(/\u0000/g, '');

    // Neutralise formula-injection prefixes by prepending a single quote.
    // The leading apostrophe is a well-known signal to spreadsheet apps
    // that the cell is plain text.
    if (FORMULA_PREFIX.test(text)) {
        text = `'${text}`;
    }

    // RFC 4180: any field that contains `"`, `,`, CR or LF must be
    // enclosed in double quotes; embedded `"` is doubled.
    const needsQuoting = /[",\r\n]/.test(text);
    if (needsQuoting) {
        text = `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function csvRow(values) {
    return values.map(escapeCsvField).join(',');
}

function csvFilename(base, ext = 'csv') {
    const cleanBase = String(base ?? 'export')
        // Block path traversal + header injection in Content-Disposition.
        .replace(/[\r\n"\\/\\:*?<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'export';
    const cleanExt = String(ext ?? 'csv').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 10) || 'csv';
    return `${cleanBase}.${cleanExt}`;
}

module.exports = { escapeCsvField, csvRow, csvFilename };
