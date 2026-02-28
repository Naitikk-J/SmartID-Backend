// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Environment Configuration
// Validates all env vars on startup using Zod
// ═══════════════════════════════════════════════════════════════

const { z } = require('zod');
require('dotenv').config();

const envSchema = z.object({
    // Application
    NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(4000),

    // Database
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // Redis
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    // JWT
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('8h'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    // AES Encryption
    AES_KEY: z.string().length(64, 'AES_KEY must be exactly 64 hex characters (32 bytes)'),
    AES_IV_LENGTH: z.coerce.number().default(16),

    // AWS S3 (optional in dev)
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().default('ap-south-1'),

    // Firebase (optional in dev)
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),

    // CORS — comma-separated list of allowed origins
    DASHBOARD_URL: z.string().default('http://localhost:5173'),

    // Sentry (optional)
    SENTRY_DSN: z.string().optional(),
});

let config;

try {
    config = envSchema.parse(process.env);
} catch (err) {
    console.error('❌ Invalid environment variables:');
    console.error(err.flatten().fieldErrors);
    if (process.env.NODE_ENV === 'production') {
        console.error('⚠️ Continuing in production despite invalid env vars (for debugging)');
        // Provide a partial config to prevent total crash
        config = {
            ...process.env,
            NODE_ENV: process.env.NODE_ENV || 'production',
            PORT: process.env.PORT || 4000,
            __invalid: true,
            __errors: err.flatten().fieldErrors
        };
    } else {
        process.exit(1);
    }
}

module.exports = config;
