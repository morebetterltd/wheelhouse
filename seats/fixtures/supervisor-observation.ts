// Fixture-only completion joins and native decision markers in a copied script.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const file = process.argv[2], original = fs.readFileSync(file, "utf8");
let source = original;
function replace(old: string, next: string) { assert.equal(source.split(old).length, 2, "one observation anchor: " + old); source = source.replace(old, () => next); }
replace('--once) tick ;;', `--once) tick; fixture_rc=$?; for fixture_job in $(jobs -p); do
  wait "$fixture_job"; fixture_job_rc=$?
  printf '{"job":%s,"native":%s}\\n' "$fixture_job" "$fixture_job_rc" >> "$RUN/fixture-once-results.jsonl"
  [ "$fixture_job_rc" = 0 ] || fixture_rc="$fixture_job_rc"
done
printf '{"pid":%s,"native":%s,"now":"%s"}\\n' "$$" "$fixture_rc" "\${WHEELHOUSE_SUPERVISOR_NOW:-actual}" >> "$RUN/fixture-once-results.jsonl"
exit "$fixture_rc" ;;`);
replace('while supervisor_holder_alive "$pid"; do sleep "$INTERVAL"; done', 'while supervisor_holder_alive "$pid"; do printf "%s\\n" "$$" >> "$RUN/fixture-holder-waits"; sleep "$INTERVAL"; done');
replace('  echo $$ > "$PID_FILE"', `  if pid_alive "$old"; then fixture_old_alive=1; else fixture_old_alive=0; fi
  printf '%s %s %s\\n' "$$" "\${old:-none}" "$fixture_old_alive" >> "$RUN/fixture-holder-claims"
  echo $$ > "$PID_FILE"`);
fs.writeFileSync(file, source);
console.log("SUPERVISOR_OBSERVATION " + JSON.stringify({ file: path.basename(file), sourceSha256: createHash("sha256").update(original).digest("hex"), changes: "join only copied --once jobs; mark actual wait-loop and PID publication decisions" }));
