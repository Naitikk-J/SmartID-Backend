---
status: awaiting_human_verify
trigger: "Investigate issue: vercel-routes-503-unavailable"
created: 2026-03-24T15:51:42Z
updated: 2026-03-24T15:56:53Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: Static-literal route requires resolve Vercel bundling omission and prevent loadRoute fallback 503 for deployed API paths.
test: Validate app load and sample protected endpoints under production-like env to confirm routes mount (401 auth expected, not 503 unavailable).
expecting: Route responses should be auth errors or normal handler errors, with no "route is temporarily unavailable" fallback payload.
next_action: request human verification on deployed Vercel endpoint after redeploy.

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: access, scan, auth, students endpoints should respond normally
actual: all endpoints return 503 'route is temporarily unavailable'
errors: frontend shows 503 on /api/v1/access/gates, /api/v1/access/activity-logs, /api/v1/scan/recent; deployed root previously had backend init errors, now app runs but routes fallback
reproduction: call https://smart-id-backend.vercel.app/api/v1/access/gates
timeline: started after prior backend init failures and partial hardening changes

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Missing production dependency (ioredis) causes widespread route import failure.
	evidence: package.json declares ioredis under dependencies and route-by-route require tests succeeded locally in production mode.
	timestamp: 2026-03-24T15:55:38Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-03-24T15:52:27Z
	checked: src/app.js loader usage via text search
	found: loadRoute wraps all route module imports and returns a fallback router that emits 503 with "<route> route is temporarily unavailable".
	implication: Any top-level require failure in a route module causes deployed endpoints to degrade to fallback without crashing app startup.

- timestamp: 2026-03-24T15:52:27Z
	checked: src/routes/*.routes.js inventory
	found: 12 route modules are loaded through loadRoute, including access and scan paths seen in symptoms.
	implication: A shared dependency used across many route files is a high-probability single-point import failure.

- timestamp: 2026-03-24T15:53:33Z
	checked: src/routes/access.routes.js, src/routes/scan.routes.js, src/routes/auth.routes.js, src/routes/students.routes.js
	found: Multiple core routes import shared modules at top-level, especially ../middleware/auth and ../config/database.
	implication: A single top-level throw in shared middleware/config can fail several route imports and trigger 503 fallbacks broadly.

- timestamp: 2026-03-24T15:53:33Z
	checked: src/middleware/auth.js
	found: middleware/auth has top-level require('ioredis') before any try/catch, while Redis connection itself is lazy.
	implication: If ioredis is unavailable in deployment, importing middleware/auth throws immediately and route modules fail to load.

- timestamp: 2026-03-24T15:55:38Z
	checked: production-like route-by-route import script
	found: all 12 route files import successfully locally even with invalid service env values.
	implication: The failure is not intrinsic route code initialization; likely deployment packaging/runtime-specific.

- timestamp: 2026-03-24T15:55:38Z
	checked: src/app.js route loader pattern
	found: all route modules are required via dynamic require(modulePath) using variable strings.
	implication: Vercel file tracing can miss dynamically required files, causing runtime MODULE_NOT_FOUND and route fallback 503 in deployment.

- timestamp: 2026-03-24T15:56:53Z
	checked: production-like app load after src/app.js patch
	found: app loads successfully with invalid env fallback path still active.
	implication: Static route loader refactor did not break app initialization.

- timestamp: 2026-03-24T15:56:53Z
	checked: smoke requests to /api/v1/access/gates and /api/v1/scan/recent via supertest
	found: both endpoints now return 401 Authentication required (from route middleware), not 503 route unavailable fallback.
	implication: Routes are mounted and executable; fallback behavior no longer intercepts these endpoints in local production-like run.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: 
root_cause: Dynamic route loading in src/app.js uses variable-path require(modulePath), which can prevent Vercel's serverless file tracer from bundling route modules; at runtime each require fails and loadRoute returns 503 fallback routers.
fix: 
fix: Updated src/app.js route loader to use static literal require calls wrapped in per-route loader functions, preserving fallback behavior while allowing Vercel file tracing to include route modules in the serverless bundle.
verification: Local production-like smoke validation passed (APP_LOAD_OK + protected routes return 401 instead of 503 fallback). Deployment verification pending on Vercel after redeploy.
files_changed: [src/app.js]
