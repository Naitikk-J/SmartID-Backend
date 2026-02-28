// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — JWT Authentication Middleware
// authenticate, requireRole, requireModule
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { AppError } = require('./errorHandler');
const Redis = require('ioredis');

const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => {
        if (times > 3) return null; // stop retrying after 3 attempts
        return Math.min(times * 50, 2000);
    }
});

redis.on('error', (err) => {
    console.warn('⚠️ Redis connection error:', err.message);
});

redis.on('connect', () => {
    console.log('✅ Redis connected');
});

/**
 * Authenticate — extracts and verifies JWT from Authorization header.
 * Checks Redis blacklist for logged-out tokens.
 */
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new AppError('Authentication required', 401, 'NO_TOKEN');
        }
        const token = authHeader.split(' ')[1];
        if (!token || token === 'null' || token === 'undefined') {
            throw new AppError('Invalid token format', 401, 'INVALID_TOKEN');
        }

        // Check Redis blacklist (logged-out tokens)
        const isBlacklisted = await redis.get(`blacklist:${token}`);
        if (isBlacklisted) {
            throw new AppError('Token has been revoked', 401, 'TOKEN_REVOKED');
        }

        // Verify JWT
        const decoded = jwt.verify(token, config.JWT_SECRET);
        req.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            department: decoded.department,
            module: decoded.module,
        };
        req.token = token;
        next();
    } catch (err) {
        if (err instanceof AppError) return next(err);
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            return next(err);
        }
        next(new AppError('Authentication failed', 401, 'AUTH_FAILED'));
    }
};

/**
 * requireRole — factory that returns middleware checking if user has one of the specified roles.
 * Role hierarchy: SUPER_ADMIN > DEPT_ADMIN > MODULE_ADMIN > OPERATOR
 */
const ROLE_HIERARCHY = {
    SUPER_ADMIN: 4,
    DEPT_ADMIN: 3,
    MODULE_ADMIN: 2,
    FACULTY: 1,
    OPERATOR: 1,
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return next(new AppError('Authentication required', 401));
        }

        // SUPER_ADMIN can do anything
        if (req.user.role === 'SUPER_ADMIN') {
            return next();
        }

        if (!roles.includes(req.user.role)) {
            return next(new AppError('Forbidden — insufficient role', 403, 'FORBIDDEN'));
        }
        next();
    };
};

/**
 * requireModule — factory that checks if user's module matches, or is SUPER_ADMIN.
 */
const requireModule = (moduleName) => {
    return (req, res, next) => {
        if (!req.user) {
            return next(new AppError('Authentication required', 401));
        }
        if (req.user.role === 'SUPER_ADMIN') {
            return next();
        }
        if (req.user.module !== moduleName) {
            return next(new AppError(`Forbidden — requires ${moduleName} module access`, 403, 'FORBIDDEN'));
        }
        next();
    };
};

module.exports = { authenticate, requireRole, requireModule, redis };
