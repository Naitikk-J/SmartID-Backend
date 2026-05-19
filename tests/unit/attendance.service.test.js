jest.mock('../../src/config/database', () => ({
    attendanceSession: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
    },
    attendanceRecord: {
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
    },
    subject: { findUnique: jest.fn() },
    student: { findMany: jest.fn() },
    sessionClassList: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
    },
}));

jest.mock('../../src/services/geofencing-settings.service', () => ({
    getGeofencingSettings: () => ({
        campusCenterLat: 26.2183,
        campusCenterLng: 78.1828,
        campusRadiusMetres: 500,
        attendanceRadiusMetres: 200,
    }),
}));

const prisma = require('../../src/config/database');
const attendance = require('../../src/services/attendance.service');

describe('attendance.service.markAttendance', () => {
    beforeEach(() => jest.clearAllMocks());

    const openSession = () => ({
        id: 'sess1',
        status: 'OPEN',
        startedAt: new Date(),
        windowMinutes: 15,
        subject: { timetableSlots: [] },
    });

    test('rejects when session is missing', async () => {
        prisma.attendanceSession.findUnique.mockResolvedValue(null);
        await expect(
            attendance.markAttendance({ sessionId: 'x', studentId: 's' }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('rejects closed session', async () => {
        prisma.attendanceSession.findUnique.mockResolvedValue({ ...openSession(), status: 'CLOSED' });
        await expect(
            attendance.markAttendance({ sessionId: 'x', studentId: 's' }),
        ).rejects.toMatchObject({ statusCode: 400, code: 'TIME_EXPIRED' });
    });

    test('rejects when window has elapsed', async () => {
        const old = openSession();
        old.startedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
        prisma.attendanceSession.findUnique.mockResolvedValue(old);
        await expect(
            attendance.markAttendance({ sessionId: 'x', studentId: 's' }),
        ).rejects.toMatchObject({ code: 'TIME_EXPIRED' });
    });

    test('rejects when GPS is far from campus', async () => {
        prisma.attendanceSession.findUnique.mockResolvedValue(openSession());
        await expect(
            attendance.markAttendance({
                sessionId: 'x',
                studentId: 's',
                gpsLat: 28.6139, // Delhi
                gpsLng: 77.2090,
            }),
        ).rejects.toMatchObject({ code: 'GPS_FAIL' });
    });

    test('marks attendance on the happy path', async () => {
        prisma.attendanceSession.findUnique.mockResolvedValue(openSession());
        prisma.attendanceRecord.create.mockResolvedValue({ id: 'r1', student: { id: 's' } });
        const record = await attendance.markAttendance({
            sessionId: 'sess1',
            studentId: 's',
            gpsLat: 26.2183,
            gpsLng: 78.1828,
        });
        expect(record).toMatchObject({ id: 'r1' });
        expect(prisma.attendanceRecord.create).toHaveBeenCalledTimes(1);
    });

    test('translates Prisma P2002 into 409 DUPLICATE', async () => {
        prisma.attendanceSession.findUnique.mockResolvedValue(openSession());
        const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        prisma.attendanceRecord.create.mockRejectedValue(p2002);
        await expect(
            attendance.markAttendance({
                sessionId: 'sess1',
                studentId: 's',
                gpsLat: 26.2183,
                gpsLng: 78.1828,
            }),
        ).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE' });
    });

    test('manual override skips GPS + time checks', async () => {
        const old = openSession();
        old.startedAt = new Date(Date.now() - 60 * 60 * 1000);
        prisma.attendanceSession.findUnique.mockResolvedValue(old);
        prisma.attendanceRecord.create.mockResolvedValue({ id: 'r1' });
        await expect(
            attendance.markAttendance({
                sessionId: 'sess1',
                studentId: 's',
                overrideById: 'admin1',
                overrideReason: 'Phone dead',
            }),
        ).resolves.toMatchObject({ id: 'r1' });
    });
});

describe('attendance.service.autoExpireStaleSessions', () => {
    beforeEach(() => jest.clearAllMocks());

    test('closes only stale sessions', async () => {
        const now = Date.now();
        prisma.attendanceSession.findMany.mockResolvedValue([
            { id: 'fresh', startedAt: new Date(now - 60_000), windowMinutes: 15 },
            { id: 'stale', startedAt: new Date(now - 60 * 60_000), windowMinutes: 15 },
        ]);
        prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });

        const closed = await attendance.autoExpireStaleSessions();
        expect(closed).toBe(1);
        expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['stale'] } },
            data: { status: 'CLOSED', closedAt: expect.any(Date) },
        });
    });

    test('returns 0 when nothing is stale', async () => {
        prisma.attendanceSession.findMany.mockResolvedValue([
            { id: 'fresh', startedAt: new Date(), windowMinutes: 15 },
        ]);
        const closed = await attendance.autoExpireStaleSessions();
        expect(closed).toBe(0);
        expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
    });
});

describe('attendance.service.haversineDistance', () => {
    test('Gwalior → Delhi ≈ 289km', () => {
        const d = attendance.haversineDistance(26.2183, 78.1828, 28.6139, 77.2090);
        expect(d).toBeGreaterThan(280_000);
        expect(d).toBeLessThan(310_000);
    });
});
