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

    // Redis (optional when using stateless access QR flow)
    REDIS_URL: z.string().optional(),

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

    // Python Face AI service
    FACE_AI_URL: z.string().default('http://localhost:8001'),
    FACE_AI_TIMEOUT_MS: z.coerce.number().default(10000),

    // Dynamic access QR
    ACCESS_QR_TTL_SECONDS: z.coerce.number().int().min(10).max(120).default(30),
    ACCESS_REQUIRE_GEOFENCE: z.string().default('false'),

    // SMTP mail (optional, used for scheduled event CSV reports
    // AND campus-entry credential delivery emails)
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    SMTP_SECURE: z.string().optional(),

    // ── Campus Entry (Smart-ID daily entry) ──────────────────
    // The name of the evergreen CampusEvent seeded on startup that
    // anchors every daily student entry. If it does not exist it
    // will be auto-created by the campusEntry.service on boot.
    CAMPUS_ENTRY_EVENT_NAME: z.string().default('MITS Campus Entry'),
    // Email domain(s) allowed for Google sign-in on the STUDENT
    // portal. Comma-separated. First one is the "official" one
    // shown on the login page.
    CAMPUS_ENTRY_STUDENT_DOMAIN: z.string().default('mitsjwl.ac.in'),
    // Rotating student QR TTL. Kept short so a stolen screenshot
    // becomes worthless in seconds. Do NOT surface this to the
    // student UI (spec: no countdown timer).
    CAMPUS_ENTRY_QR_TTL_SECONDS: z.coerce.number().int().min(10).max(60).default(20),
    // Public URL shown inside the credentials email (where the
    // student should log in). If unset the dashboard URL + /student
    // will be used.
    CAMPUS_ENTRY_LOGIN_URL: z.string().optional(),

    // Cron auth token (used by serverless scheduled triggers)
    CRON_SECRET: z.string().optional(),

    // RFID Reader Authentication
    RFID_DEVICE_SECRET_SALT: z.string().min(16).optional(),
    RFID_HEARTBEAT_INTERVAL_MS: z.coerce.number().default(30000),
    RFID_OFFLINE_GRACE_MINUTES: z.coerce.number().default(5),

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
