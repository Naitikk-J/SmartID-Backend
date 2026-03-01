// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Reports Routes
// Campus occupancy, attendance summary, custom reports
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');

const router = express.Router();

// ── GET /campus-occupancy ───────────────────────────────────
router.get('/campus-occupancy', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const entries = await prisma.scanEvent.count({
            where: { scanType: 'GATE_ENTRY', result: 'VERIFIED', scannedAt: { gte: todayStart, lte: todayEnd } },
        });
        const exits = await prisma.scanEvent.count({
            where: { scanType: 'GATE_EXIT', result: 'VERIFIED', scannedAt: { gte: todayStart, lte: todayEnd } },
        });

        // Hourly breakdown
        const hourlyData = [];
        for (let h = 0; h < 24; h++) {
            const hourStart = new Date(todayStart);
            hourStart.setHours(h);
            const hourEnd = new Date(todayStart);
            hourEnd.setHours(h + 1);

            const [hEntries, hExits] = await Promise.all([
                prisma.scanEvent.count({
                    where: { scanType: 'GATE_ENTRY', result: 'VERIFIED', scannedAt: { gte: hourStart, lt: hourEnd } },
                }),
                prisma.scanEvent.count({
                    where: { scanType: 'GATE_EXIT', result: 'VERIFIED', scannedAt: { gte: hourStart, lt: hourEnd } },
                }),
            ]);

            hourlyData.push({ hour: h, entries: hEntries, exits: hExits });
        }

        res.json({
            success: true,
            data: { studentsOnCampus: entries - exits, entries, exits, hourly: hourlyData },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /entry-summary ──────────────────────────────────────
router.get('/entry-summary', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const entries = await prisma.scanEvent.findMany({
            where: {
                scanType: 'GATE_ENTRY',
                result: { startsWith: 'VERIFIED' }, // Matches VERIFIED and REENTERED_N
                scannedAt: { gte: todayStart, lte: todayEnd }
            },
            select: {
                student: {
                    select: { department: true }
                }
            }
        });

        // Group by department
        const summary = {};
        for (const entry of entries) {
            const dept = entry.student?.department || 'Unknown';
            if (!summary[dept]) summary[dept] = 0;
            summary[dept]++;
        }

        res.json({ success: true, data: { summary } });
    } catch (err) {
        next(err);
    }
});

// ── GET /attendance-summary ─────────────────────────────────
router.get('/attendance-summary', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const { startDate, endDate } = req.query;
        const where = {};
        if (startDate || endDate) {
            where.startedAt = {};
            if (startDate) where.startedAt.gte = new Date(startDate);
            if (endDate) where.startedAt.lte = new Date(endDate);
        }

        const sessions = await prisma.attendanceSession.findMany({
            where,
            include: {
                subject: true,
                records: { select: { studentId: true } },
            },
        });

        // Group by department
        const deptSummary = {};
        for (const session of sessions) {
            const dept = session.subject.department;
            if (!deptSummary[dept]) {
                deptSummary[dept] = { totalSessions: 0, totalRecords: 0 };
            }
            deptSummary[dept].totalSessions++;
            deptSummary[dept].totalRecords += session.records.length;
        }

        res.json({ success: true, data: { summary: deptSummary } });
    } catch (err) {
        next(err);
    }
});

// ── GET /gate-activity ──────────────────────────────────────
router.get('/gate-activity', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const gates = await prisma.gate.findMany({
            include: {
                scanEvents: {
                    where: { scannedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
                    select: { scanType: true, result: true, scannedAt: true },
                },
            },
        });

        const activity = gates.map((gate) => ({
            gateId: gate.id,
            gateName: gate.name,
            totalScans: gate.scanEvents.length,
            verified: gate.scanEvents.filter((e) => e.result === 'VERIFIED').length,
            denied: gate.scanEvents.filter((e) => ['FAKE', 'LIMIT_HIT', 'LOST'].includes(e.result)).length,
        }));

        res.json({ success: true, data: { activity } });
    } catch (err) {
        next(err);
    }
});

// ── GET /library-stats ──────────────────────────────────────
router.get('/library-stats', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const [totalBooks, booksOut, overdueCount] = await Promise.all([
            prisma.book.count(),
            prisma.libraryTransaction.count({ where: { returnedAt: null } }),
            prisma.libraryTransaction.count({ where: { returnedAt: null, dueAt: { lt: new Date() } } }),
        ]);

        // Most borrowed
        const mostBorrowed = await prisma.libraryTransaction.groupBy({
            by: ['bookId'],
            _count: true,
            orderBy: { _count: { bookId: 'desc' } },
            take: 10,
        });

        const bookIds = mostBorrowed.map((m) => m.bookId);
        const books = await prisma.book.findMany({ where: { id: { in: bookIds } } });
        const bookMap = Object.fromEntries(books.map((b) => [b.id, b]));

        res.json({
            success: true,
            data: {
                totalBooks,
                booksOut,
                overdueCount,
                mostBorrowed: mostBorrowed.map((m) => ({
                    book: bookMap[m.bookId],
                    borrowCount: m._count,
                })),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /custom — Custom report builder ────────────────────
router.post('/custom', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { metrics = [], dateRange, departments = [] } = req.body;
        const startDate = dateRange?.startDate ? new Date(dateRange.startDate) : new Date(new Date().setDate(new Date().getDate() - 30));
        const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

        const report = {};

        for (const metric of metrics) {
            switch (metric) {
                case 'Attendance':
                    report.attendance = await prisma.attendanceRecord.count({
                        where: { markedAt: { gte: startDate, lte: endDate } },
                    });
                    break;
                case 'Gate Traffic':
                    report.gateTraffic = {
                        entries: await prisma.scanEvent.count({
                            where: { scanType: 'GATE_ENTRY', scannedAt: { gte: startDate, lte: endDate } },
                        }),
                        exits: await prisma.scanEvent.count({
                            where: { scanType: 'GATE_EXIT', scannedAt: { gte: startDate, lte: endDate } },
                        }),
                    };
                    break;
                case 'Canteen Revenue':
                    const debits = await prisma.walletTransaction.aggregate({
                        where: { type: 'DEBIT', createdAt: { gte: startDate, lte: endDate } },
                        _sum: { amount: true },
                    });
                    report.canteenRevenue = parseFloat(debits._sum.amount || 0);
                    break;
                case 'Exit Violations':
                    report.exitViolations = await prisma.scanEvent.count({
                        where: { result: 'LIMIT_HIT', scannedAt: { gte: startDate, lte: endDate } },
                    });
                    break;
                default:
                    break;
            }
        }

        res.json({
            success: true,
            data: { report, dateRange: { startDate, endDate } },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
