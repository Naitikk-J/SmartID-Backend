const { escapeCsvField, csvRow, csvFilename } = require('../../src/utils/csv');

describe('escapeCsvField', () => {
    test('passes through plain strings', () => {
        expect(escapeCsvField('Alice')).toBe('Alice');
    });

    test('quotes fields with commas, quotes, or newlines', () => {
        expect(escapeCsvField('A,B')).toBe('"A,B"');
        expect(escapeCsvField('She said "hi"')).toBe('"She said ""hi"""');
        expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    });

    test('neutralises formula-injection prefixes', () => {
        // The canonical CVE: an attacker registers a student named
        // "=cmd|' /C calc'!A0" — opening the CSV in Excel runs cmd.
        expect(escapeCsvField('=cmd|0')).toBe("'=cmd|0");
        expect(escapeCsvField('+1+1')).toBe("'+1+1");
        expect(escapeCsvField('-1*cmd')).toBe("'-1*cmd");
        expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
        expect(escapeCsvField('\tinjection')).toBe("'\tinjection");
    });

    test('handles non-string types', () => {
        expect(escapeCsvField(42)).toBe('42');
        expect(escapeCsvField(true)).toBe('true');
        expect(escapeCsvField(null)).toBe('');
        expect(escapeCsvField(undefined)).toBe('');
        expect(escapeCsvField({ x: 1 })).toBe('"{""x"":1}"');
    });

    test('strips NUL bytes', () => {
        expect(escapeCsvField('A\u0000B')).toBe('AB');
    });

    test('Date is serialised as ISO', () => {
        const d = new Date('2024-01-15T10:00:00Z');
        expect(escapeCsvField(d)).toBe('2024-01-15T10:00:00.000Z');
    });
});

describe('csvRow', () => {
    test('joins cells with comma after escaping', () => {
        expect(csvRow(['Alice', 'Bob, Jr.', '=hack'])).toBe("Alice,\"Bob, Jr.\",'=hack");
    });
});

describe('csvFilename', () => {
    test('returns base.ext on safe input', () => {
        expect(csvFilename('scan_logs_2024-01-15')).toBe('scan_logs_2024-01-15.csv');
    });

    test('strips path separators', () => {
        // The function replaces `/` and `\` with `_` and collapses runs.
        // The base is preserved (dots are not stripped — harmless in a
        // browser's Save-As filename), but no directory traversal is
        // possible because Content-Disposition doesn't interpret paths.
        const out = csvFilename('../../etc/passwd');
        expect(out).not.toContain('/');
        expect(out).not.toContain('\\');
        expect(out.endsWith('.csv')).toBe(true);
    });

    test('strips CRLF (HTTP header injection)', () => {
        const out = csvFilename('abc\r\nX-Evil: 1');
        expect(out).not.toMatch(/[\r\n:]/);
        expect(out.endsWith('.csv')).toBe(true);
    });

    test('falls back to "export" on empty input', () => {
        expect(csvFilename('')).toBe('export.csv');
        expect(csvFilename('___')).toBe('export.csv');
    });

    test('truncates long names', () => {
        const long = 'x'.repeat(500);
        expect(csvFilename(long).length).toBeLessThanOrEqual(80 + '.csv'.length);
    });

    test('sanitises extension', () => {
        // Shell metacharacters and spaces are dropped from the extension.
        expect(csvFilename('export', 'csv;rm -rf /')).toBe('export.csvrmrf');
    });
});
