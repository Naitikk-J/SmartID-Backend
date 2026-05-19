// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Jest Configuration
// ═══════════════════════════════════════════════════════════════
module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/tests/setup.js'],
    testMatch: [
        '<rootDir>/tests/unit/**/*.test.js',
        '<rootDir>/tests/integration/**/*.test.js',
    ],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/jobs/**',
        '!src/sockets/**',
        '!src/server.js',
    ],
    coverageThreshold: {
        global: {
            statements: 35,
            branches: 25,
            functions: 30,
            lines: 35,
        },
    },
    moduleFileExtensions: ['js', 'json'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10000,
    verbose: false,
};
