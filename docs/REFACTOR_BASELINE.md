# Refactor baseline (P0)

Recorded 2026-09-08 on Windows in `E:/GithubProject/best-ip` before production
refactoring. Git HEAD: `0f03429dfa88bcb78e2e8dac7b4e982aead2ca33`.
`PLAN.md` was untracked. No production files or existing tests were changed by P0.
Environment: uv 0.12.10, Node v24.16.0, npm 12.0.2, Wrangler 4.125.0.
No credentials, deployment, live subscription or real Actions run were used.

## Existing commands, before adding contract tests

| Command | Exit | Observed result |
| --- | --- | --- |
| `uv run pytest -q` | 0 | 112 passed, 1 warning in 4.37s |
| `uv run ruff check .` | 0 | All checks passed! |
| `npm test` | 0 | syntax checks pass; frontend 22/22, Worker 9/9 |
| `npm run dry-run` | 0 | 6 asset files; upload 85.18 KiB / gzip 21.21 KiB; ASSETS binding; dry-run exits normally |

The existing Python warning is `StarletteDeprecationWarning` from
`.venv/Lib/site-packages/fastapi/testclient.py:1`: using httpx with
starlette.testclient is deprecated; its message recommends httpx2.
No pre-existing test failures were observed. No dependency change was attempted.
Frontend reported 521.3188 ms; Worker reported 179.4504 ms. These timings and
bundle sizes are observations, not acceptance thresholds.

## Added P0 checks

| Command | Result |
| --- | --- |
| `uv run pytest tests/test_contracts.py -q` | 10 passed in 0.12s |
| `uv run ruff check tests/test_contracts.py` | All checks passed! |
| `node --test tests/contracts.test.mjs` | 8 passed, 0 failed (126.0646 ms) |
| `git diff --check` | exit 0 |

`tests/fixtures/contracts/records.json` is shared by Python and JS. Tests call
ResultStore write/finalize/export and the real browser readArtifact ZIP validator.
They cover success, partial, all failed, invalid identity, and two deliberately
recorded validation differences. Python also rejects corrupted manifest digests;
JS rejects corrupted result digests. Lifecycle samples cover environment failure
and cancellation without inventing completed artifacts.
Worker test invokes its real fetch entry with mocked external GitHub network,
checks outgoing dispatch body against workflow inputs, uses real exactRun with
workflow run-name, and real artifact lookup with workflow upload naming.
The generated test-only signing key exists in memory only.

The new JS file is deliberately outside the original package test list because
P0 owns no package configuration. Run it explicitly until the integration owner
adds `tests/contracts.test.mjs` to `npm test` (or an existing test glob).

## Differences that must not disappear in a pure move

- Python rejects failed records with exit IP and successful records missing proxy
  evidence; browser artifact reader currently accepts them. Fixture expectations
  document this gap, not an endorsement of weakening validation. A later security
  correction must intentionally change JS expectations and record why.
- Artifact `usable` is false for partial nodes, even with verified exit IP.
  Structural completion, node usability, and workflow success are distinct.
- Environment failure has no stable code/phase contract yet. Health checks core
  file presence only. Cancellation response does not itself prove runner cleanup.
- README's broad scan-token statement does not describe POST accurately: POST
  issues the token; it cannot require a previously issued scan token.

## Integration handoff

- Python contract import currently uses `backend.app.result_store.ResultStore`
  and `ResultStoreError`; migrate it to the real results module when the old
  entry is removed, keeping write/finalize/export validation under test.
- JS loads `frontend/zip-reader.js` into a VM and uses `window.BestIpZip` only
  because this is the P0 public entry. Replace reader() with an ESM import of
  `frontend/src/artifact/reader.js` after migration; do not add a second validator.
- Worker import is `worker/index.js` default fetch plus `internals.exactRun`
  and `internals.findArtifact`. Move only the latter imports to their real
  modules when internals is removed. Keep exercising default fetch for dispatch.
- Use PLAN's health/start/poll/cancel and ScanSnapshot adapter boundary;
  preserve HTTP and artifact v1, explicitly distinguish execution vs result
  availability, and keep unknown progress totals null.

This baseline proves offline behavior only. Local process startup, cancellation
cleanup, real enrichment and Worker -> Actions -> artifact remain separate
acceptance steps in PLAN.md, not claims made by these tests.
