// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Elections Routes
// Create election, vote, results, publish
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const scanService = require('../services/scan.service');

const router = express.Router();

const createElectionSchema = z.object({
    title: z.string().min(1),
    candidates: z.array(z.string().min(1)).min(2, 'At least 2 candidates required'),
    openAt: z.string().datetime().or(z.string()),
    closeAt: z.string().datetime().or(z.string()),
});

const voteSchema = z.object({
    rawToken: z.string().min(1),
    candidate: z.string().min(1),
});

// ── POST / — Create election ────────────────────────────────
router.post('/', authenticate, requireRole('SUPER_ADMIN'), validate(createElectionSchema), async (req, res, next) => {
    try {
        const election = await prisma.election.create({
            data: {
                title: req.body.title,
                candidates: req.body.candidates,
                openAt: new Date(req.body.openAt),
                closeAt: new Date(req.body.closeAt),
            },
        });
        res.status(201).json({ success: true, data: { election } });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/results — Vote tally ──────────────────────────
router.get('/:id/results', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const election = await prisma.election.findUnique({
            where: { id: req.params.id },
        });
        if (!election) throw new AppError('Election not found', 404);

        const votes = await prisma.vote.groupBy({
            by: ['candidate'],
            where: { electionId: req.params.id },
            _count: true,
        });

        const totalVotes = await prisma.vote.count({
            where: { electionId: req.params.id },
        });

        const results = election.candidates.map((c) => {
            const voteData = votes.find((v) => v.candidate === c);
            return { candidate: c, votes: voteData?._count || 0 };
        });

        res.json({
            success: true,
            data: {
                election: { id: election.id, title: election.title, isPublished: election.isPublished },
                totalVotes,
                results: results.sort((a, b) => b.votes - a.votes),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/publish — Publish results ────────────────────
router.patch('/:id/publish', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const election = await prisma.election.update({
            where: { id: req.params.id },
            data: { isPublished: true },
        });
        res.json({ success: true, data: { election } });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/vote — Cast vote via QR scan ──────────────────
router.post('/:id/vote', authenticate, requireRole('SECURITY_GUARD', 'SUPER_ADMIN'), validate(voteSchema), async (req, res, next) => {
    try {
        const electionId = req.params.id;
        const election = await prisma.election.findUnique({
            where: { id: electionId },
        });
        if (!election) throw new AppError('Election not found', 404);

        const now = new Date();
        if (now < election.openAt || now > election.closeAt) {
            throw new AppError('Election is not currently open', 403, 'ELECTION_CLOSED');
        }

        if (!election.candidates.includes(req.body.candidate)) {
            throw new AppError('Invalid candidate', 400, 'INVALID_CANDIDATE');
        }

        // Use scan service for vote verification
        const result = await scanService.verifyScan({
            rawToken: req.body.rawToken,
            scanType: 'VOTE_CAST',
            operatorId: req.user.id,
            metadata: { electionId, candidate: req.body.candidate },
        });

        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
