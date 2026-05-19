const { escapeRegex, safeContains, orContains } = require('../../src/utils/search');

describe('escapeRegex', () => {
    test('escapes every regex metacharacter', () => {
        expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
        expect(escapeRegex('.*')).toBe('\\.\\*');
        expect(escapeRegex('[abc]')).toBe('\\[abc\\]');
        expect(escapeRegex('(x|y)?')).toBe('\\(x\\|y\\)\\?');
    });

    test('passes plain alphanumerics through', () => {
        expect(escapeRegex('Alice123')).toBe('Alice123');
    });
});

describe('safeContains', () => {
    test('returns null on empty/whitespace/nullish', () => {
        expect(safeContains(null)).toBeNull();
        expect(safeContains(undefined)).toBeNull();
        expect(safeContains('')).toBeNull();
        expect(safeContains('   ')).toBeNull();
    });

    test('trims and length-caps', () => {
        expect(safeContains('   Alice   ')).toBe('Alice');
        expect(safeContains('A'.repeat(200))).toHaveLength(80);
        expect(safeContains('A'.repeat(200), { maxLen: 5 })).toBe('AAAAA');
    });

    test('escapes regex injection', () => {
        // Without escaping, ".*" matches every record.
        expect(safeContains('.*')).toBe('\\.\\*');
        // Without escaping, "(a+a+)+" is a classic ReDoS pattern.
        expect(safeContains('(a+a+)+')).toBe('\\(a\\+a\\+\\)\\+');
    });
});

describe('orContains', () => {
    test('returns null for empty term', () => {
        expect(orContains('', ['fullName'])).toBeNull();
    });

    test('builds an array of `contains` clauses for each field', () => {
        const clauses = orContains('Smith', ['fullName', 'enrollmentNo']);
        expect(clauses).toEqual([
            { fullName: { contains: 'Smith', mode: 'insensitive' } },
            { enrollmentNo: { contains: 'Smith', mode: 'insensitive' } },
        ]);
    });

    test('escapes regex specials inside the clause', () => {
        const clauses = orContains('.*', ['fullName']);
        expect(clauses[0].fullName.contains).toBe('\\.\\*');
    });
});
