// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Auth Routes
// POST /login, /refresh, /logout, GET /me
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../config/env');
const prisma = require('../config/database');
const { authenticate, redis } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { loginRateLimit } = require('../middleware/rateLimit');
const { AppError } = require('../middleware/errorHandler');
const { logAction } = require('../services/audit.service');

const router = express.Router();

// ── Validation schemas ───────────────────────────────────────
const loginSchema = z.object({
    email: z.string().email('Valid email required'),
    password: z.string().min(1, 'Password required'),
});

const refreshSchema = z.object({
    refreshToken: z.string().min(1, 'Refresh token required'),
});

// ── Helper: generate tokens ─────────────────────────────────
function generateTokens(user) {
    const payload = {
        id: user.id,
        email: user.email,
        role: user.role,
        department: user.department,
        module: user.module,
    };
    const accessToken = jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
    const refreshToken = jwt.sign({ id: user.id, type: 'refresh' }, config.JWT_SECRET, {
        expiresIn: config.JWT_REFRESH_EXPIRES_IN,
    });
    return { accessToken, refreshToken };
}

// ── POST /login ─────────────────────────────────────────────
router.post('/login', loginRateLimit, validate(loginSchema), async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const user = await prisma.adminUser.findUnique({ where: { email } });
        if (!user) {
            throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
        }
        if (!user.isActive) {
            throw new AppError('Account is deactivated', 401, 'ACCOUNT_INACTIVE');
        }

        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            await logAction(req, {
                action: 'LOGIN_FAILURE',
                entity: 'AdminUser',
                entityId: user.id,
                userId: user.id,
                newValue: { email, reason: 'Invalid password' }
            }).catch(() => { });
            throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
        }

        // Update last login
        await prisma.adminUser.update({
            where: { id: user.id },
            data: { lastLogin: new Date() },
        });

        const tokens = generateTokens(user);

        await logAction(req, {
            action: 'LOGIN_SUCCESS',
            entity: 'AdminUser',
            entityId: user.id,
            userId: user.id
        }).catch(() => { });

        res.json({
            success: true,
            data: {
                ...tokens,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    department: user.department,
                    module: user.module,
                    gateId: user.gateId,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /refresh ───────────────────────────────────────────
router.post('/refresh', validate(refreshSchema), async (req, res, next) => {
    try {
        const { refreshToken } = req.body;
        const decoded = jwt.verify(refreshToken, config.JWT_SECRET);

        if (decoded.type !== 'refresh') {
            throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
        }

        const user = await prisma.adminUser.findUnique({ where: { id: decoded.id } });
        if (!user || !user.isActive) {
            throw new AppError('User not found or inactive', 401, 'INVALID_TOKEN');
        }

        const tokens = generateTokens(user);

        res.json({
            success: true,
            data: { accessToken: tokens.accessToken },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /logout ────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
    try {
        // Add token to Redis blacklist with 8h TTL
        try {
            await redis.set(`blacklist:${req.token}`, '1', 'EX', 8 * 60 * 60);
        } catch (redisErr) {
            console.warn('⚠️ Failed to blacklist token in Redis on logout (skipping):', redisErr.message);
        }

        await logAction(req, {
            action: 'LOGOUT',
            entity: 'AdminUser',
            entityId: req.user.id
        }).catch(() => { });

        res.json({ success: true, data: { message: 'Logged out successfully' } });
    } catch (err) {
        next(err);
    }
});

// ── GET /me ─────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
    res.json({ success: true, data: { user: req.user } });
});

module.exports = router;
