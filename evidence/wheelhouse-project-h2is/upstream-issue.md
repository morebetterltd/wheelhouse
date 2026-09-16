# codex-cli 0.144.0 logs a stale models cache ERROR on every start when `models_cache.json` lacks `base_instructions`

## Exact error line

```text
2026-09-16T00:36:09.198815Z ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 80 column 5
```

I saw the same failure mode in earlier starts at a different line number when the stale cache had different formatting:

```text
ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 133 column 5
```

## Version

```text
codex-cli 0.144.0
```

## Minimal repro

This uses a fresh scratch `CODEX_HOME`, not a normal account directory. Seed the scratch home with a stale `models_cache.json` whose model objects do not contain `base_instructions`, then start Codex once:

```bash
scratch="$PWD/.scratch-codex-home"
mkdir -p "$scratch"
python3 - <<'PY'
import json, pathlib
src = pathlib.Path.home() / ".codex" / "models_cache.json"
dst = pathlib.Path(".scratch-codex-home/models_cache.json")
data = json.loads(src.read_text())
for model in data.get("models", []):
    model.pop("base_instructions", None)
dst.write_text(json.dumps(data, indent=2))
PY
CODEX_HOME="$scratch" codex exec --json --skip-git-repo-check -s read-only -c approval_policy=never 'Reply OK' </dev/null
```

Observed transcript excerpt:

```text
Reading additional input from stdin...
2026-09-16T00:36:09.198815Z ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 80 column 5
2026-09-16T00:36:09.202773Z ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 80 column 5
{"type":"thread.started","thread_id":"01a0a7a4-7977-7662-8334-6f7d0643570b"}
{"type":"turn.started"}
```

## Stale cache shape vs loader expectation

The stale cache is a JSON object with these top-level fields and no credential or account fields:

```json
{
  "fetched_at": "...",
  "etag": "...",
  "client_version": "0.144.0",
  "models": [
    {
      "slug": "gpt-reserve",
      "display_name": "GPT-Reserve",
      "description": "Fast and affordable agentic coding model.",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" }
      ],
      "shell_type": "shell_command",
      "visibility": "hide",
      "supported_in_api": true,
      "priority": 3,
      "additional_speed_tiers": ["fast"],
      "service_tiers": [
        { "id": "priority", "name": "Fast", "description": "1.5x speed, increased usage" }
      ],
      "availability_nux": null,
      "upgrade": null
    }
  ]
}
```

In the current 0.144.0 cache, each model object also contains `base_instructions` (a string) along with other newer model metadata. The loader appears to deserialize model entries with `base_instructions` as a required field, so older cache files are logged as an ERROR instead of being treated as a cache miss / schema-version mismatch.

## Impact

The command can continue after printing the cache-load ERROR, so this is not fatal by itself. In long-running automation, though, every Codex start writes the line to stderr. Wheelhouse Codex seats preserve harness stderr in seat `.stderr.log` files; the line reads like active distress and causes false positives for humans or scripts that inspect seat logs for `ERROR`.

## Suggested fix

Treat `models_cache.json` as an untrusted cache across CLI upgrades: include an explicit cache schema version, invalidate/refetch when required fields are missing, or deserialize newly added fields such as `base_instructions` as optional with a default. If the cache must be ignored, prefer a DEBUG/WARN message that says the models cache was stale and will be refreshed, not an ERROR on every start.
