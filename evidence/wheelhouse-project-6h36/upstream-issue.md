# Claude Code stream-json interrupt result omits the `result` field entirely

## Version

```text
2.1.273 (Claude Code)
```

## Minimal repro

A scratch `CLAUDE_CONFIG_DIR` repro is not useful without logging that directory in, so this uses the operator's existing default Claude Code login, matching the local harness-probe method. Run a stream-json session, send one normal user message, then send a second message that starts a long-running Bash tool and interrupt it with `control_request` while the tool is running.

Command shape:

```bash
env -u ANTHROPIC_API_KEY claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --model sonnet \
  --permission-mode acceptEdits \
  --permission-prompts none \
  --allowedTools 'Bash(sleep *)'
```

Input shape:

```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: probe-1"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Run Bash sleep 5, then reply FINAL"}]}}
{"type":"control_request","request":{"subtype":"interrupt","request_id":"wh-int-1"}}
```

The committed repro transcript here reuses the existing local harness-probe capture at `wheelhouse/evidence/harness-probes/claude-multiturn.events.jsonl` and reduces it to the fields relevant to the schema issue.

## Observed behavior

A normal successful turn's result event contains a string `result`:

```json
{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","stop_reason":"end_turn","num_turns":1,"result_index":0,"result":"probe-1"}
```

The interrupt is acknowledged and the turn is marked interrupted:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"wh-int-1","response":{"still_queued":[]}}}
{"type":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}
```

But the final result event has no `result` key at all:

```json
{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools","stop_reason":"tool_use","num_turns":3,"result_index":4,"errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]}
```

The reduced transcript's explicit check is:

```text
result_key_present=false
```

## Expected behavior

The stream-json result schema should be stable across terminal result events. Either:

- include `result` with an empty string for interrupted turns;
- include `result: null`; or
- document that interrupted `type=result` events omit `result`, and expose a stable discriminator clients can use without probing field presence.

Any of those is easier for clients than a field that exists on normal result events but disappears on the interrupt path.

## Seat-level impact

Wheelhouse's Claude-Code driver consumes stream-json events for resident seats. A parser that treats `event.result` as an always-present string throws on an interrupted turn even though the event is otherwise a normal terminal `type=result` event. The template driver now guards this by treating missing `result` on `error_during_execution` / aborted tool turns as an interrupted turn and recording that state in the seat log instead of dereferencing blindly.

## Suggested fix

Make the result-event payload shape explicit and stable for control-request interrupts. Prefer emitting `result: ""` or `result: null` on the interrupted terminal event, or document the omission and add a dedicated field such as `interrupted: true` / `terminal_reason: "interrupted"` that clients can branch on.
