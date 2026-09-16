# Claude Code allowedTools `Bash(printf *)` denies `printf x > file` without explaining that redirection defeated the rule

## Version

```text
2.1.273 (Claude Code)
```

## Minimal repro

A scratch `CLAUDE_CONFIG_DIR` repro is not possible without logging that directory in. This repro uses the operator's existing default Claude Code login, matching the local harness-probe method. The command disables `ANTHROPIC_API_KEY` and uses `--setting-sources project` so user settings do not supply extra permissions.

Run in an empty scratch working directory:

```bash
env -u ANTHROPIC_API_KEY claude -p --output-format json --model sonnet \
  --setting-sources project \
  --allowedTools 'Bash(printf *)' \
  --permission-prompts none \
  'Use Bash to run exactly: printf x > redirected.txt. Then answer CREATED if the tool ran, DENIED if the tool was denied.' </dev/null

env -u ANTHROPIC_API_KEY claude -p --output-format json --model sonnet \
  --setting-sources project \
  --allowedTools 'Bash(printf *)' \
  --permission-prompts none \
  'Use Bash to run exactly: printf x. Then answer OUTPUT followed by the stdout if the tool ran, DENIED if the tool was denied.' </dev/null
```

## Observed behavior

Redirected form, with the prefix rule present:

```text
RUN allowedTools Bash(printf *) with redirected command
result: {"subtype":"success","is_error":false,"terminal_reason":"completed","num_turns":2,"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"printf x > redirected.txt","description":"Write x to redirected.txt"}}],"result":"DENIED"}
redirected_rc=0
redirected_exists=no
```

Plain form, with the same prefix rule:

```text
RUN allowedTools Bash(printf *) with plain command
result: {"subtype":"success","is_error":false,"terminal_reason":"completed","num_turns":2,"permission_denials":[],"result":"OUTPUT x"}
plain_rc=0
```

The denial object names the tool and command but does not say why `Bash(printf *)` failed to cover the command, nor that the output redirect changed permission matching.

The same failure shape was captured earlier in `wheelhouse/evidence/harness-probes/claude-permission-pregrant.txt`:

```text
--allowedTools Bash(printf *) Bash(ls *) --permission-prompts none
permission_denials: [{"tool_name":"Bash","tool_input":{"command":"printf x > perm-C.txt","description":"Write x to perm-C.txt"}}]
result: DENIED
file exists after run: no
```

## Expected behavior

Either:

1. `Bash(printf *)` should cover `printf x > redirected.txt`, since the command string starts with `printf `; or
2. the denial should explicitly say that the rule did not match because shell redirection is treated specially, naming both the attempted rule (`Bash(printf *)`) and the redirect token/form that made it unsafe.

Silent denial is hard to distinguish from a missing allow rule, malformed allow rule, or prompt/model choice that produced a different command.

## Seat-level impact

Wheelhouse Claude-Code seats run unattended. If a roster relies on narrow `allowedTools` entries, a command that appears to match a prefix can still be denied when it uses output redirection, and the seat log only shows a generic permission denial. That is one reason the template's Claude-Code driver defaults to the measured-safe `--permission-mode acceptEdits --permission-prompts none` mode, and why its docs tell operators to verify any allowlist against redirected/write forms before depending on it.

## Suggested fix

Document and expose the matcher semantics for shell operators/redirection in Bash allow rules. If redirects intentionally require a different rule, include that reason in `permission_denials` and the human-readable denial message. If redirects are not intended to defeat a prefix match, normalize/match the complete shell command consistently with the visible command string.
