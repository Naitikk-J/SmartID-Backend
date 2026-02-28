let app;
try {
    app = require('../src/app');
} catch (err) {
    console.error('CRITICAL: Failed to load Express app:', err);
    const express = require('express');
    app = express();
    app.all('*', (req, res) => {
        res.status(500).json({
            success: false,
            error: 'Backend failed to initialize',
            message: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    });
}

// Prepare for Vercel: export the express app
module.exports = app;
