# Production scan CLI

Actions runs the shared `ScanJobManager` directly, without FastAPI or the real-scan
acceptance script. The three dispatch inputs, run title, pinned Mihomo version,
artifact name, one-day retention, and schema v1 remain unchanged.

```bash
uv run python scripts/run_scan.py \
  --request-id <request-id> \
  --subscription-file <runner-temp/subscription-url> \
  --output-dir <runner-temp/action-artifact>
```

The subscription file contains one HTTP(S) URL, not subscription YAML. Keep it
private; the caller owns and removes it. The CLI never logs its contents and
downloads the subscription only once, then injects that exact in-memory snapshot
into the shared manager. Core configuration still uses `BEST_IP_MIHOMO_PATH` and
the existing `BEST_IP_*` limits. No test subscription secret is used in production.

`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` supply positive run identity. Explicit
`--run-id`/`--run-attempt` must agree with those variables when present. Outside
Actions, use `--local-test` for synthetic identity (defaults 1/1); this flag is
rejected in Actions. Such artifacts are local acceptance data, not real runs.
Request IDs match `[A-Za-z0-9_-]{1,128}`. `--timeout` defaults to 1500 seconds and
must be positive and finite; its budget includes the subscription download.

Each invocation owns isolated temporary job/result directories. Timeout and
cancellation wait for manager shutdown. Cleanup failures take precedence over
the original failure and prevent publication. Unconfirmed workspaces are kept
for diagnosis rather than deleted from beneath a potentially running core.
After confirmed shutdown and temporary-directory cleanup, both JSON files are
written in a staging directory and published together. The output directory must
not already exist; user files are never overwritten or removed.

At least one success or partial node with validated exit evidence is required.
All-failed scans are not successful. Schema v1 `status.usable` retains its stricter
legacy meaning (no failed or partial nodes), so a valid partial artifact may have
`usable=false` while the CLI exits successfully.

| Exit | Safe code | Meaning |
| --- | --- | --- |
| 0 | `scan_completed` | Valid artifact published after cleanup |
| 2 | `input_invalid` | Arguments, identity, URL file, or subscription invalid |
| 3 | `environment_not_ready` | Core/configuration/runtime unavailable |
| 4 | `scan_unavailable` | No usable results or unexpected scan failure |
| 5 | `result_invalid` | Export, manifest, records, or credential check failed |
| 6 | `scan_timeout` | Budget expired; cancellation/shutdown awaited |
| 7 | `cleanup_failed` | Resource cleanup unconfirmed; no artifact published |
| 8 | `output_failed` | Destination exists or publication failed |
| 130 | `scan_cancelled` | Interrupted/cancelled; no artifact published |

Failures print only fixed safe codes/messages, never raw exception text. Offline
tests with synthetic fixtures prove structure and lifecycle, not public-network
Mihomo execution or Worker→Actions end-to-end acceptance.
