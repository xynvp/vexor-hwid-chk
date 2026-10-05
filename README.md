# Vexor HWID verification

An external support verification system. Staff copies information from the existing Vexor panel; this project calls no Vexor API and performs no Vexor reset itself.

Available under the [MIT license](LICENSE). Deploy your own backend and provision your own staff accounts. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Architecture

- `apps/hwid-chk`: customer Tauri 2 application, plain TypeScript UI, native Rust Windows identity collection and background heartbeats every three seconds.
- `apps/hwid-admin`: authenticated staff Tauri application, session dashboard, reset snapshot, manual claim preview comparison and audit history.
- `crates/desktop-core`: native Windows APIs, HTTPS transport and memory-only tokens. Each app registers only its own commands.
- `worker`: Cloudflare Worker API, D1 migrations, server-side identity hashing, authentication, rate limits and Discord outbox/retries.
- `scripts`: local secret initialization, secure admin provisioning, releases and real desktop integration tests.

HWID is lowercase SHA-256 of UTF-8 `MachineGuid + decimal C: volume serial + ComputerName`, with no separators or case conversion. Preview is the first 14 hex characters, `…`, and last 6. Both Rust and Worker tests include the exact supplied Vexor vector.

The Worker stores the final HWID and independently domain-separated HMAC-SHA256 component fingerprints. Raw identifiers exist only in transient collection/request memory; they are never written to D1, logs, notifications or a client configuration file. Windows information is client-reported. Do not enter full license keys, passwords or private machine identifiers into notes.

## Development on Windows

Install Node.js 24 LTS, stable Rust with the MSVC target, Visual Studio C++ Build Tools with the Windows SDK, and Microsoft Edge WebView2 Runtime. Cargo's standard `Cargo.toml`/`Cargo.lock` names are the naming exception. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Run from the repository root:

```powershell
npm ci
Copy-Item worker/wrangler.example.toml worker/wrangler.toml
npm run init:local
npm run db:local
npm run admin:create
```

Admin provisioning prompts for a username and hidden password (minimum 14 characters). Only its salted PBKDF2 hash is inserted into D1. A temporary SQL file containing the hash is removed afterward. There is no hardcoded password; local accounts are provisioned explicitly.

Repeat provisioning for additional staff accounts. Every enabled staff account can access the same verification sessions and history; the dashboard loads the latest 200 sessions. License keys in source examples and tests are synthetic fixtures.

Run each command in a separate terminal:

```powershell
npm run dev:worker
npm run dev:admin
npm run dev:checker
```

The development backend is `http://127.0.0.1:8787`. Debug apps allow HTTP **only** on localhost; release apps require HTTPS. The frontends have no direct network access: Tauri IPC calls Rust, which sends requests with no browser Origin header. Keep `ALLOWED_ORIGINS` empty unless you intentionally add an exact trusted browser origin.

Local D1 persists in `worker/.wrangler/state`. Restarting Wrangler preserves sessions, opaque token hashes, snapshots and audit history. Keep the same local fingerprint secret across restarts. `.dev.vars`, `.wrangler`, build outputs and test data are ignored by Git.

## Support workflow

1. Staff signs in, creates a verification with Vexor username, numeric UID, full license key, old preview and an optional note. Session details show the full key with a copy button; session lists and Discord notifications show a masked key such as `VXP-****-****-F8B3`.
2. Share **only `hwid-chk.exe`** and the generated `VXH-` code with the customer. The production endpoint is already embedded. Codes contain eight uniformly random characters, expire after 15 minutes and can connect one checker.
3. Customer starts verification and leaves the checker open for the entire reset and reclaim process. After connection, the visible code cannot authenticate more clients. Heartbeats use a server-issued 256-bit opaque token.
4. With the checker online, select **Mark HWID Reset** and confirm. This snapshots the currently monitored full HWID as `expected_hwid`; staff performs the actual reset in the Vexor panel.
5. Customer reclaims the key while the checker remains open. Changes to any identity component create audit events and a persistent warning after reset.
6. Copy the post-claim Vexor preview into **Verify Claim**. Whitespace and three dots are accepted as harmless paste formatting; hex case is not changed.
7. A matching expected preview completes as **VERIFIED**. A different preview completes as **HWID MISMATCH**. The checker receives the final state on its next heartbeat.

Verification requires a heartbeat within the last 12 seconds. Dashboard polling and the minute cron record expired/disconnected sessions; reconnect resumes with the same token and is audited. The checker automatically retries transient failures with backoff up to 30 seconds. Closing/restarting the checker discards its token; staff should cancel the old session and issue a new code. If the initial connection response is lost, a new code may also be necessary. Admin sessions expire after 30 minutes and logout revokes them server-side.

**Evidence limits:** a preview comparison checks only the visible prefix/suffix. It does not prove the full hidden panel HWID matches, identify the claimant, or establish hardware attestation. A patched client can forge values. A preview MATCH remains a preview match even if the PC changed during reset; the separate continuity warning stays visible and is included in audit metadata and notifications. Staff should investigate that warning.

Checker authorization ends with the verification. There is a five-minute grace period to deliver the final status, after which the server rejects the token. Token hashes may remain on the audit record but no longer authorize requests.

## Cloudflare setup and deployment

Copy `production.example.json` to `production.json` and configure your own Cloudflare account, Worker name, database ID and deployed HTTPS origin. Local `production.json` and `worker/wrangler.toml` are ignored by Git; the repository provides setup examples rather than live deployment coordinates.

```powershell
npx wrangler login
npx wrangler d1 create hwid-db
```

Put the returned database ID in `worker/wrangler.toml`. Set an `account_id` there if you have multiple Cloudflare accounts. Choose a unique Worker name if needed. The example database ID can be used for local development only.

Deploy from the repository root:

```powershell
cd worker
node ../node_modules/wrangler/bin/wrangler.js d1 migrations apply hwid-db --remote
node ../node_modules/wrangler/bin/wrangler.js secret put HWID_FINGERPRINT_SECRET
# Optional Discord notifications:
node ../node_modules/wrangler/bin/wrangler.js secret put DISCORD_WEBHOOK_URL
node ../node_modules/wrangler/bin/wrangler.js deploy
cd ..
npm run admin:create -- --remote
```

Use at least 32 random bytes for `HWID_FINGERPRINT_SECRET` and keep the secret unchanged across deployments. Store the optional webhook only in Cloudflare secrets. Opaque admin sessions use stored token hashes; there is no separate admin session secret.

Update `production.json` with the deployed HTTPS origin before building releases. `npm run release` embeds that origin; direct Tauri release builds must explicitly set `VEXOR_API_URL`. Debug builds default to localhost. Release checker/login screens contain no server field.

The optional Windows helper `npm run provision:production` generates missing secrets and an initial staff account only if no enabled account exists. Generated credentials are stored in the current user's protected `%LOCALAPPDATA%/vexor/staff-credentials.json`, outside the repository and executables. It does not rotate an existing fingerprint secret.

The full-key migration renames `verification_sessions.license_suffix` to `license_key` without rebuilding tables or changing session IDs, audit history, or queued notifications. Existing suffix-only values are preserved and shown as legacy sessions with the full key unavailable; those missing characters cannot be recovered. New verifications require the full `VXP` key with ten groups of four hexadecimal characters. The API uses `license_key` for creation and staff session responses. Update the Worker and admin app together; older admin binaries still submit the removed suffix field. Run `npm run db:local` to upgrade an existing local database.

Cron runs each minute to expire sessions, detect disconnects, purge expired admin tokens/rate-limit buckets and retry Discord delivery. Notifications are sent only for session connection, reset, final result and expiration. The durable outbox retries failures five times with backoff; failures are audited and never change claim results. Outbox payloads contain only session identifiers and previews. Cloudflare request/body observability is disabled by default; do not configure logging to capture Authorization headers or request bodies.

Public errors are generic. Server logs include request IDs, classified errors and webhook delivery attempts without sensitive values. Audit rows have D1 triggers preventing UPDATE/DELETE. This is an application-level append-only trail, not protection against the Cloudflare database owner. Back up D1 and choose a retention policy appropriate for support records; this implementation does not automatically erase audit evidence.

## Checks and releases

```powershell
npm run check
npm run build
npm test
cargo test --workspace
npm run release
```

`npm run release` runs TypeScript checks, Worker/D1 integration tests, Rust tests, both frontend builds and optimized Tauri Windows builds. It produces:

```text
dist/
  hwid-chk.exe
  hwid-admin.exe
  checksums.txt
```

Both applications are portable x64 Windows executables with embedded frontend assets and no release console/devtools/source maps. They use the installed WebView2 Runtime; they do not bundle a browser. Customers receive only `hwid-chk.exe`. Releases are unsigned; use your organization's signing certificate for trusted distribution. Configure your own backend through `production.json` or the `VEXOR_API_URL` build environment variable.

Worker tests run the actual Workers runtime and local D1, including migrations, the HWID vector, invalid/expired codes, auth/logout/expiration, token separation, reconnect, confirmation/reset snapshot, MATCH/MISMATCH, component changes, request validation, rate limits, webhook failures, concurrent resets, immutable events and database restart/persistence. Test credentials and secrets are ephemeral fixtures, never application defaults.

Real Windows desktop tests additionally drive both executable UIs with native Windows collection, Rust transport and Worker/D1. They test MATCH/MISMATCH and restart the backend while the checker remains open to verify automatic reconnect and persistence:

```powershell
cargo install tauri-driver --locked
# Download a Microsoft Edge driver matching your installed WebView2 version.
$env:MSEDGEDRIVER = 'C:\tools\msedgedriver.exe'
npm run build:desktop-test
npm run test:desktop
npm run test:release
```

Ports 4444–4447 must be free. Screenshots and a result record are saved under ignored `test-data/`. The test creates its own temporary D1 and randomly generated admin password; it uses neither production services nor Discord. See the [Tauri WebDriver documentation](https://v2.tauri.app/develop/tests/).

## Desktop design and production validation

Both windows use Tauri's frameless mode, a custom draggable title bar, minimize/close controls and a dark native window background. The admin supports resizing, maximize/restore and title-bar double-click. The checker is a fixed 390 × 580 logical-pixel utility. Windows 11 compositor rounding is requested and the native border color is suppressed; older Windows safely ignore unsupported DWM attributes. Windows manages DPI scaling. Shared components provide buttons, inputs, sections, status indicators/pills, confirmation sheets, loading/empty states, copy controls, sidebar items, session rows and toasts.

Run `node scripts/test-production.mjs` after building releases to validate the **actual release executables** against production HTTPS Worker/D1. It loads the protected local staff credentials, exercises matching/mismatching resets with real Windows collection/background heartbeats, checks event history, login/logout, production endpoint selection, maximize/restore, clipboard feedback and layout overflow. Validation sessions remain marked as production-check in the immutable audit history. Results and screenshots go in ignored `test-data/`. Credentials, tokens and raw machine identifiers are never printed.
