// Minimal global setup. Tests that need a real DB should set DATABASE_URL.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_'.padEnd(64, 'x');
process.env.AES_KEY = process.env.AES_KEY
    || 'REDACTED';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mongodb://localhost:27017/test';

// Silence noisy console output from modules under test.
const noop = () => {};
if (!process.env.JEST_VERBOSE) {
    jest.spyOn(console, 'log').mockImplementation(noop);
    jest.spyOn(console, 'warn').mockImplementation(noop);
}
