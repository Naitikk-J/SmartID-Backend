// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Error Handler Middleware
// AppError class + global error handler
// ═══════════════════════════════════════════════════════════════

const logger = require('../config/logger');

class AppError extends Error {
    constructor(message, statusCode, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code || null;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

const errorHandler = (err, req, res, _next) => {
    // Default values
    let statusCode = err.statusCode || 500;
    let message = err.message || 'Internal server error';
    let code = err.code || null;

    // Prisma errors
    if (err.code === 'P2002') {
        statusCode = 409;
        const field = err.meta?.target?.join(', ') || 'field';
        message = `Duplicate value for: ${field}`;
        code = 'DUPLICATE';
    } else if (err.code === 'P2025') {
        statusCode = 404;
        message = 'Record not found';
        code = 'NOT_FOUND';
    } else if (err.code === 'P2003') {
        statusCode = 400;
        message = 'Invalid reference — related record does not exist';
        code = 'INVALID_REFERENCE';
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        statusCode = 401;
        message = 'Invalid token';
        code = 'INVALID_TOKEN';
    } else if (err.name === 'TokenExpiredError') {
        statusCode = 401;
        message = 'Token expired';
        code = 'TOKEN_EXPIRED';
    }

    // Zod validation errors
    if (err.name === 'ZodError') {
        statusCode = 400;
        message = 'Validation failed';
        code = 'VALIDATION_ERROR';
    }

    // Log only server errors with stack trace
    if (statusCode >= 500) {
        logger.error({
            requestId: req.requestId,
            message: err.message,
            stack: err.stack,
            url: req.originalUrl,
            method: req.method,
        });
    } else {
        logger.warn({
            requestId: req.requestId,
            message,
            statusCode,
            url: req.originalUrl,
        });
    }

    // Never leak stack traces in production
    const response = {
        success: false,
        error: message,
        ...(code && { code }),
        ...(err.name === 'ZodError' && { details: err.flatten?.().fieldErrors }),
        ...(process.env.NODE_ENV === 'development' && statusCode >= 500 && { stack: err.stack }),
    };

    res.status(statusCode).json(response);
};

module.exports = { AppError, errorHandler };
