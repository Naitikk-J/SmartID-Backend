// Confirms the `since` polling cursor on getRecentScans builds the
// right Prisma `where` filter and survives nonsense input.
//
// Jest hoists `jest.mock` calls; the mock factory may only reference
// variables whose names start with `mock` (case-insensitive). Hence
// `mockFindMany` / `mockCount`.

const mockFindMany = jest.fn();
const mockCount = jest.fn();

jest.mock('../../src/config/database', () => ({
    scanEvent: {
        findMany: (...args) => mockFindMany(...args),
        count: (...args) => mockCount(...args),
    },
}));

const { getRecentScans } = require('../../src/services/scan.service');

beforeEach(() => {
    mockFindMany.mockReset();
    mockFindMany.mockResolvedValue([]);
    mockCount.mockReset();
    mockCount.mockResolvedValue(0);
});

describe('getRecentScans `since` cursor', () => {
    test('adds a gt filter when `since` is an ISO string', async () => {
        await getRecentScans({ since: '2024-01-15T10:00:00Z', limit: 10 });
        const args = mockFindMany.mock.calls[0][0];
        expect(args.where.scannedAt.gt).toBeInstanceOf(Date);
        expect(args.where.scannedAt.gt.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    });

    test('ignores invalid `since` values', async () => {
        await getRecentScans({ since: 'not-a-date' });
        const args = mockFindMany.mock.calls[0][0];
        expect(args.where.scannedAt).toBeUndefined();
    });

    test('combines `since` with `date` (day filter wins gte/lte, since adds gt)', async () => {
        await getRecentScans({ date: '2024-01-15', since: '2024-01-15T11:00:00Z' });
        const args = mockFindMany.mock.calls[0][0];
        expect(args.where.scannedAt.gte).toBeInstanceOf(Date);
        expect(args.where.scannedAt.lte).toBeInstanceOf(Date);
        expect(args.where.scannedAt.gt).toBeInstanceOf(Date);
    });

    test('caps the page size at the configured maximum', async () => {
        await getRecentScans({ limit: 99999 });
        const args = mockFindMany.mock.calls[0][0];
        // Pagination util caps at 200 for this endpoint.
        expect(args.take).toBeLessThanOrEqual(200);
    });
});
