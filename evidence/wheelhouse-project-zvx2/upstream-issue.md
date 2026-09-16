# codex-cli 0.144.0 retries 401s for an unauthenticated CODEX_HOME instead of failing fast with a login-required error

## Version

```text
codex-cli 0.144.0
```

## Minimal repro

Use a fresh scratch `CODEX_HOME` with no login and no API key, then run one turn:

```bash
scratch="$PWD/.scratch-codex-home"
rm -rf "$scratch"
mkdir -p "$scratch"
CODEX_HOME="$scratch" env -u OPENAI_API_KEY codex login status
CODEX_HOME="$scratch" env -u OPENAI_API_KEY \
  codex exec --json --skip-git-repo-check -s read-only -c approval_policy=never 'Reply OK' </dev/null
```

The login-status check returns immediately:

```text
Not logged in
login_status_rc=1
```

But the turn still starts and spends time retrying unauthenticated API calls before failing.

## Measured retry timeline

Measured on 2026-09-16 with the command above. The run started at `2026-09-16T00:40:22Z` and ended at `2026-09-16T00:40:41Z` with `rc=1`, about 19 seconds later. Earlier local probes for the same failure mode took about 45 seconds; the exact duration appears to vary with retry timing/network, but the failure shape is the same: websocket 401 retries, websocket-to-HTTPS fallback, HTTPS 401 retries, then `turn.failed`.

```text
+00.00s start=2026-09-16T00:40:22Z
+03.01s 2026-09-16T00:40:25.006367Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+03.79s 2026-09-16T00:40:25.787963Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+04.77s 2026-09-16T00:40:26.767783Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+04.77s {"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ...)"}
+05.58s 2026-09-16T00:40:27.581962Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+05.58s {"type":"error","message":"Reconnecting... 3/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ...)"}
+06.78s 2026-09-16T00:40:28.777983Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+06.78s {"type":"error","message":"Reconnecting... 4/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ...)"}
+08.71s 2026-09-16T00:40:30.714953Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+08.71s {"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ...)"}
+12.47s 2026-09-16T00:40:34.474625Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
+12.47s {"type":"item.completed","item":{"type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ..."}}
+12s..19s {"type":"error","message":"Reconnecting... 1/5 ... url: https://api.openai.com/v1/responses ..."}
+12s..19s {"type":"error","message":"Reconnecting... 2/5 ... url: https://api.openai.com/v1/responses ..."}
+12s..19s {"type":"error","message":"Reconnecting... 3/5 ... url: https://api.openai.com/v1/responses ..."}
+12s..19s {"type":"error","message":"Reconnecting... 4/5 ... url: https://api.openai.com/v1/responses ..."}
+12s..19s {"type":"error","message":"Reconnecting... 5/5 ... url: https://api.openai.com/v1/responses ..."}
+19.00s {"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, ..."}}
+19.00s end=2026-09-16T00:40:41Z rc=1
```

## Expected behavior

For a `CODEX_HOME` with no login and no API key, `codex exec` / app-server turn startup should fail fast before opening a model turn, with a clear login-required error such as: `Not logged in; run codex login or provide an API key`. It should not spend a full retry budget on websocket and HTTPS transports when the local credential state is already known to be absent.

## Seat-level impact

Wheelhouse starts Codex seats as resident app-server processes. A dead or never-provisioned login currently looks like a hung seat during readiness or first turn: the process is alive and printing retry noise, but no useful authenticated turn can succeed until the retry budget is exhausted. This obscures the real operator action (login/provision the `CODEX_HOME`) and delays failure handling for every affected seat.

## Suggested fix

Before creating a turn or app-server session, check the selected `CODEX_HOME` for usable credentials (the same information surfaced by `codex login status`). If credentials are absent, return a deterministic login-required error immediately and skip transport retries. If an API key route is configured through environment, keep supporting that route, but otherwise fail before contacting `/v1/responses`.
