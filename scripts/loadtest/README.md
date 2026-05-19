# MITS Smart ID — Load testing

[k6](https://k6.io) scenarios for stressing the API before each release.
Each script is a standalone executable file; pass overrides via env
vars (`BASE_URL`, `TOKEN`, etc.).

## Install k6 once

```bash
# macOS
brew install k6
# Linux
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6
```

## Pre-flight

Spin up a **staging** copy of the backend pointed at a **staging
Mongo + Redis**. Never load test production: rate limits and audit
log writes are not free.

```bash
export BASE_URL=https://staging.api.smart-id.mits.local
export ADMIN_EMAIL=loadtest.admin@mits.local
export ADMIN_PASSWORD=please-change-me
export STUDENT_TOKEN_FILE=./tokens.json  # see seed-tokens.js below
```

## Generate a realistic token pool

`scan-verify.js` needs AES-encrypted QR payloads that decrypt cleanly
on the server. Generate them from staging data with the helper script:

```bash
AES_KEY=<same as the API server> \
DATABASE_URL=mongodb://...staging-url... \
node scripts/loadtest/generate-tokens.js \
    --count=2000 \
    --gate=<gateId> \
    --gps-lat=26.234 --gps-lng=78.181 \
    --out=scripts/loadtest/tokens.json
```

The script refuses to run against a `DATABASE_URL` that contains
`prod` / `production` unless `I_KNOW_WHAT_IM_DOING=1` is set. Use it.

## Suites

| Script | What it stresses | Recommended profile |
|--------|------------------|---------------------|
| `auth-login.js`    | `/auth/login` — bcrypt CPU, JWT signing, Redis writes | 50 VU × 1m  |
| `scan-verify.js`   | `/scan/verify` — AES-GCM decrypt, geofence, Redis lock | 200 VU × 2m |
| `recent-feed.js`   | `/scan/recent` — Mongo pagination + cache hits         | 100 VU × 1m |
| `health-deep.js`   | `/health/deep` — dependency pings                      | 20 VU × 30s |

## Run

```bash
# Single scenario
k6 run scripts/loadtest/scan-verify.js

# All scenarios sequentially with thresholds
k6 run --tag suite=full scripts/loadtest/scan-verify.js \
    && k6 run scripts/loadtest/auth-login.js \
    && k6 run scripts/loadtest/recent-feed.js \
    && k6 run scripts/loadtest/health-deep.js
```

## What "passing" means

Each script defines `thresholds` directly on the metrics it cares
about, so the run exits non-zero if any SLO breaks. As a starting
point we expect:

* `http_req_failed{expected_response:true}` < 1%
* `http_req_duration{p(95)}` < 800ms for scan, < 1500ms for login
* No 429s under the published rate limits at expected RPS

Tune the targets in `options.thresholds` per script before relying on
them as gates in CI.
