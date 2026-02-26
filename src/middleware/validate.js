// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Zod Validation Middleware
// validate(schema) factory for request body validation
// ═══════════════════════════════════════════════════════════════

const { AppError } = require('./errorHandler');

/**
 * Validate request body against a Zod schema.
 * Returns middleware that parses req.body and throws on validation failure.
 */
const validate = (schema) => {
    return (req, res, next) => {
        try {
            req.body = schema.parse(req.body);
            next();
        } catch (err) {
            if (err.name === 'ZodError') {
                const details = err.flatten().fieldErrors;
                const message = Object.entries(details)
                    .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
                    .join('; ');
                return next(new AppError(`Validation failed: ${message}`, 400, 'VALIDATION_ERROR'));
            }
            next(err);
        }
    };
};

/**
 * Validate query params against a Zod schema.
 */
const validateQuery = (schema) => {
    return (req, res, next) => {
        try {
            req.query = schema.parse(req.query);
            next();
        } catch (err) {
            if (err.name === 'ZodError') {
                const details = err.flatten().fieldErrors;
                const message = Object.entries(details)
                    .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
                    .join('; ');
                return next(new AppError(`Invalid query params: ${message}`, 400, 'VALIDATION_ERROR'));
            }
            next(err);
        }
    };
};

module.exports = { validate, validateQuery };
