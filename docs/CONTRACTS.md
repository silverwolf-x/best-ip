# Frozen contracts (P0, 2026-09-08)

This describes implementation before the PLAN.md refactor, not a new schema.
Fixtures are synthetic, credential-free examples, not evidence of a real scan.
`records.json` has a base node plus shallow case overrides; both languages
materialize the same records. The documentation IP is deliberately non-production.

## Entrypoints and boundaries

- Local: `uv run python scripts/dev.py` (also `npm run dev`), optional
  `--port`, `--frontend-port`, `--no-open`, `--no-reload`. Separate loopback
  services default to frontend 5173 and API 8000 and select free ports independently.
  `/site-config.js` supplies `window.BEST_IP_CONFIG` with local mode and actual API base.
- Backend: `uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000`.
  FastAPI `/` is 404. Local CORS allows only configured frontend Origin, methods
  GET/POST/DELETE, headers Accept/Content-Type, and no credentials.
  Windows launcher disables reload; health checks file existence, not process creation.
- Production: Worker Static Assets + Access -> GitHub App -> fixed
  `silverwolf-x/best-ip`, `main`, `.github/workflows/scan.yml`.
  P0 workflow decrypts with `scripts/decrypt_subscription.mjs`, starts loopback
  Uvicorn, runs `scripts/verify_real_scan.py`, then `scripts/sanitize_action_artifact.py`.
  A direct production CLI is a later migration, not present at P0.
- `npm run dry-run` checks bundling; `npm run deploy` publishes. Neither unit
  tests nor dry-run prove real Mihomo or Actions execution.

## Local HTTP

| Method/path | Request | Successful response |
| --- | --- | --- |
| GET `/api/health` | none | 200 `{status:"ok", mihomo_ready:boolean, mode:"local" or "runner-api"}` |
| POST `/api/scans` | JSON `{subscription_url, subscription_sha256?, request_id?}` | 202 `{id,status:"queued"}` |
| GET `/api/scans/{id}` | none | 200 job snapshot with result summaries |
| GET `/api/scans/{id}/export` | none | 200 full export with records and manifest |
| GET `/api/scans/{id}/results/{index}` | none | 200 full node record |
| DELETE `/api/scans/{id}` | none | 200 cancellation/job snapshot |

URL string length is 8..4096; optional digest is lowercase SHA-256 hex;
request IDs match `[A-Za-z0-9_-]{1,128}`. Local submission is plaintext only to
loopback and uses `credentials: omit`; it does not use the gateway token.
Errors use `{detail}`: validation 422 (safe generic text), duplicate 409,
Mihomo-not-ready 503, missing job/result 404, premature export/result 409,
and cancellation cleanup failure 500.

Job snapshots expose `id,status,message,created_at,finished_at,total,skipped,
completed,success_count,partial_count,failed_count,current_node,manifest_ready,
cleanup_confirmed,execution_mode,error,results`. Status values include queued,
preparing, running, completed, failed, cancelled. Persisted progress uses
`job_id` and `phase` (currently human-readable message), not HTTP `id/message`.
Lifecycle fixtures describe minimum failure/cancellation facts, not a promise
that environment failures already have structured codes.

## Gateway HTTP and dispatch

All requests, including static assets/config and health, require Access.
Health does not require a scan token. POST requires Access plus same-origin
Origin/Fetch-Metadata but does not require a pre-existing scan token. Subsequent
GET/DELETE/artifact requests require `X-Best-IP-Scan-Token`, an in-memory,
two-hour token bound to request ID and dispatch time. Mutations are same-origin.

- GET `/api/health`: `{status:"ok",mode:"github-actions-gateway",authenticated_email}`.
- POST `/api/scans`: `{request_id,key_id,envelope}`; returns 202
  `{request_id,run_id:null,dispatched_at,scan_token}`.
- Envelope v1: `v,kid,alg,request_id,issued_at,expires_at,ek,iv,aad,ct`;
  algorithm `RSA-OAEP-3072-SHA256+AES-256-GCM`. AES-256-GCM encrypts the URL,
  RSA-OAEP wraps the key; public-key SPKI SHA-256 must match key ID.
- Dispatch body: `{ref:"main",inputs:{request_id,key_id,
  encrypted_subscription_url:JSON.stringify(envelope)}}`.
  Workflow input names/types remain three required strings.
- GET `/api/scans/{request_id}?run_id={id}&run_attempt={attempt}`: request ID,
  normalized status, run, jobs, jobs availability/count/warning, artifact readiness
  and (once resolved) artifact ID/name. Unresolved run is `dispatching`, run null,
  jobs empty, job total null. Successful run without artifact is `artifact_pending`.
- GET `/api/scans/{request_id}/artifact?run_id={id}&run_attempt={attempt}`:
  ZIP bytes only after exact run and artifact checks, maximum 50 MiB.
- DELETE `/api/scans/{request_id}?run_id={id}`: 202
  `{request_id,run_id,status:"cancelled"}` means cancellation requested to GitHub,
  not proof of completed runner cleanup; unresolved run returns 409.
- Errors: `{error:stable_code,detail:safe_message}`, no-store; unexpected errors
  become generic `internal_error` 500.

Run title is `Best IP scan {request_id}`. Identity checks bind title, workflow,
dispatch event, branch, creation window, run and attempt. Artifact name is
`best-ip-result-{request_id}-{run_id}-{run_attempt}`, unique and not expired;
upload retention is one day. Tests exercise actual Worker dispatch and lookup.

## Result and artifact v1

Disk layout: `{job_id}/progress.json`, `nodes/0000.json` onward, `manifest.json`.
Files are atomically written. Exactly one terminal record per actual node, with
status success/partial/failed. Failed records require a safe error and null exit IP.
Success and partial require a valid IP and confirmed workspace Mihomo proxy
evidence, loopback HTTP port, no trust_env/direct fallback, and five true base
collection checks. Retry metadata, when present, must be internally consistent.
Required and optional record fields are enforced by Python's ResultStore validator;
fixtures carry the minimal valid set, not a real enrichment response.

Manifest: `schema_version:1,job_id,status:"completed",created_at,finished_at,
total,skipped,completed,all_records_present:true,complete:true,execution_mode,
counts:{success,partial,failed,complete},records`.
Each entry has `index,file,bytes,sha256,summary`; index/file are contiguous,
digest/size bind exact node bytes, summary matches the record and counts are derived.
Manifest `complete:true` means all records present, NOT all nodes usable.

Export contains completed job fields, cleanup confirmation, full `results` and
manifest. Artifact ZIP contains exactly `status.json` and `result.json` (export).
Status fields: `schema_version:1,sanitized:true,request_id,run_id,run_attempt,
status:"completed",usable,total,completed,counts,result_sha256`.
Digest covers exact UTF-8 result bytes, including formatting/newline.
Sanitizer rejects credential keys, credential-bearing URLs and subscription values.
Browser checks ZIP paths, duplicate entries, stored/deflate methods, CRC and bounded
sizes (50 MiB compressed, 100 MiB decompressed), digest, identity and aggregate facts.

Important P0 differences (recorded, not silently fixed):

1. Browser ZIP validation accepts failed-with-IP and missing proxy evidence;
   Python rejects both. Shared fixtures explicitly record both expectations.
   JS checks identity/status/summary/counts, not all Python node rules.
2. `status.usable` means zero failed AND zero partial nodes in sanitizer/browser.
   Partial artifacts are structurally accepted but usable=false. An all-failed
   manifest is structurally complete yet unusable; workflow success is not node success.
3. Environment failures and cancellations have no completed artifact in the current
   workflow. They are lifecycle samples, not fabricated terminal result archives.

## Environment variables (names only; no deployed values inspected)

| Scope | Variables/defaults |
| --- | --- |
| Local | `BEST_IP_MIHOMO_PATH` runtime/mihomo/mihomo(.exe); `BEST_IP_LOCAL_DEV` false; `BEST_IP_LOCAL_FRONTEND_ORIGIN` unset; `BEST_IP_OUTBOUND_INTERFACE` unset |
| Limits | `BEST_IP_SUBSCRIPTION_MAX_BYTES` 5242880; `BEST_IP_MAX_NODES` 500; `BEST_IP_MAX_PARALLEL_JOBS` 2; `BEST_IP_MAX_PARALLEL_NODES` 8; `BEST_IP_MAX_NODE_ATTEMPTS` 3; `BEST_IP_NODE_RETRY_BACKOFF_MS` 500; `BEST_IP_PAGE_TIMEOUT_MS` 45000; `BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS` 30 |
| Download | `BEST_IP_MIHOMO_TAG`, `BEST_IP_MIHOMO_ARCHIVE_SHA256` optional command defaults; workflow pins v1.19.30 and archive SHA-256 |
| Existing verifier | `BEST_IP_TEST_SUBSCRIPTION_URL`; `BEST_IP_API_BASE` http://127.0.0.1:8000; `BEST_IP_REAL_SCAN_TIMEOUT_SECONDS` 1800 (workflow 1500); `BEST_IP_REQUEST_ID`; `BEST_IP_ALLOW_PARTIAL` opt-in (workflow 1) |
| Worker | `SCAN_KEY_ID`, `SCAN_TOKEN_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_POLICY_AUD`, `ACCESS_ALLOWED_EMAIL`; `ASSETS` binding |
| Actions | secret `SCAN_PRIVATE_KEY_PEM`, variable `SCAN_KEY_ID`; temporary `SCAN_PRIVATE_KEY_PATH`, `BEST_IP_ENVELOPE`, `REQUEST_ID`, `KEY_ID`, `EXPECTED_KEY_ID`, `ENVELOPE`, `RUN_ID`, `RUN_ATTEMPT`; standard GitHub/runner context |
| Deployment CI | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

## Next transport boundary (not a wire-protocol change)

Use exactly `health()`, `start(subscriptionUrl)`, `poll(session)`, `cancel(session)`.
The opaque session owns token/run/attempt/dispatch time. UI never persists those.
ScanSnapshot separately represents execution, phase/safe error, progress source,
unknown totals as null, result availability and terminal node counts.
Keep local JSON and gateway encrypted envelope/ZIP distinct below this interface.
Separate unavailable, verified-with-usable-nodes, all-failed and invalid results;
do not interpret old artifact `usable=false` as absence of a partial exit IP.
An intentional change to usable or validator rules needs explicit fixture
expectation changes and migration notes, not an incidental module move.
