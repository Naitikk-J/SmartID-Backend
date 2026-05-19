// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Per-route body size guard
//
// The app-level `express.json()` allows up to 25MB (face frames).
// Most endpoints don't need anything close to that. This middleware
// short-circuits with `413 PAYLOAD_TOO_LARGE` based on the
// `Content-Length` header BEFORE body parsing happens, so an
// attacker can't fill server memory by streaming a giant JSON body.
//
// Usage:
//   router.post('/verify', bodyLimit('64kb'), validate(schema), ...);
//
// Limit accepts:
//   - a number of bytes
//   - a string with a unit: '64kb', '1mb', '512b'
// ═══════════════════════════════════════════════════════════════

const UNIT_MULTIPLIERS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };

function parseLimit(limit) {
    if (typeof limit === 'number' && Number.isFinite(limit)) return Math.max(1, Math.floor(limit));
    if (typeof limit !== 'string') return 1024 * 1024;
    const match = limit.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
    if (!match) return 1024 * 1024;
    const value = Number.parseFloat(match[1]);
    const unit = match[2] || 'b';
    return Math.max(1, Math.floor(value * UNIT_MULTIPLIERS[unit]));
}

function bodyLimit(limit) {
    const maxBytes = parseLimit(limit);
    return (req, res, next) => {
        const declared = Number.parseInt(req.headers['content-length'] || '0', 10);
        if (Number.isFinite(declared) && declared > maxBytes) {
            return res.status(413).json({
                success: false,
                error: `Request body too large (max ${maxBytes} bytes)`,
                code: 'PAYLOAD_TOO_LARGE',
            });
        }
        next();
    };
}

module.exports = { bodyLimit, parseLimit };
