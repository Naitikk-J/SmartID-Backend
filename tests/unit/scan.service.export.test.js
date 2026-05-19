// Verifies scan.service.exportScans produces CSV that is safe to
// open in Excel — formula prefixes are neutralised, fields are
// properly quoted, and ad-hoc string concatenation is gone.

const mockEvents = [];

jest.mock('../../src/config/database', () => ({
    scanEvent: {
        findMany: jest.fn().mockImplementation(() => mockEvents),
    },
}));

const scan = require('../../src/services/scan.service');

describe('scan.service.exportScans (CSV injection safety)', () => {
    beforeEach(() => { mockEvents.length = 0; });

    test('always emits a header row', async () => {
        const csv = await scan.exportScans({});
        expect(csv.split(/\r\n/)[0]).toBe(
            'Time,Enrollment No,Student Name,Department,Scan Type,Direction,Result,Badge',
        );
    });

    test('neutralises formula-injection in attacker-controlled fields', async () => {
        mockEvents.push({
            scannedAt: new Date('2024-01-15T10:00:00Z'),
            scanType: 'GATE_ENTRY',
            result: 'VERIFIED',
            student: { enrollmentNo: '=cmd|0', fullName: '+attack', department: 'CSE' },
            card: { status: 'ACTIVE' },
            metadata: {},
        });

        const csv = await scan.exportScans({});
        const lines = csv.split(/\r\n/);
        expect(lines[1]).toContain("'=cmd|0");
        expect(lines[1]).toContain("'+attack");
        // Standard cells should NOT be quoted unnecessarily.
        expect(lines[1]).toContain(',CSE,');
    });

    test('properly quotes names containing commas', async () => {
        mockEvents.push({
            scannedAt: new Date(),
            scanType: 'GATE_EXIT',
            result: 'VERIFIED',
            student: { enrollmentNo: 'E1', fullName: 'Smith, John', department: 'ME' },
            card: { status: 'ACTIVE' },
            metadata: {},
        });

        const csv = await scan.exportScans({});
        expect(csv).toMatch(/"Smith, John"/);
    });
});
