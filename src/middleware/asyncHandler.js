// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Async handler wrapper
//
// Wraps an Express handler so any rejected promise (or sync throw)
// is forwarded to `next()` instead of crashing the process. Use:
//
//   router.get('/x', asyncHandler(async (req, res) => { ... }));
// ═══════════════════════════════════════════════════════════════

function asyncHandler(handler) {
    return (req, res, next) => {
        try {
            const result = handler(req, res, next);
            if (result && typeof result.then === 'function') {
                result.catch(next);
            }
        } catch (err) {
            next(err);
        }
    };
}

module.exports = { asyncHandler };
