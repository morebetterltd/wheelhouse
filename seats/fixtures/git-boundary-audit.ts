// Test-only, conservative source audit; not a general Bash parser. Discover
// helper uses BEFORE checking their shape, so unsupported setups fail closed.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

export function auditDirectory(root: string): number {
  assert(fs.statSync(root).isDirectory(), `missing suite directory: ${root}`);
  let checked = 0;
  for (const name of fs.readdirSync(root).filter(name => name.endsWith(".selftest.sh")).sort()) {
    const lines = fs.readFileSync(path.join(root, name), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#/.test(line) || !/\bselftest_make_fixture_dir\b/.test(line)) continue;
      const where = `${name}:${i + 1}`;
      const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)=.*\bselftest_make_fixture_dir\b/.exec(line);
      assert(assignment && line.match(/\bselftest_make_fixture_dir\b/g)?.length === 1,
        `${where}: unverifiable fixture setup; expected a single-line assignment from selftest_make_fixture_dir`);
      assert(line.trimEnd().endsWith(" || exit 2"), `${where}: fixture setup must end in || exit 2`);
      assert.equal(lines[i + 1]?.trim(), `selftest_isolate_git "$${assignment[1]}" || exit 2`, `${where}: missing git boundary`);
      checked++;
    }
  }
  assert(checked > 40, `wrong suite directory: only ${checked} fixture setups`);
  return checked;
}

function regression(root: string, scratch: string): void {
  fs.mkdirSync(scratch);
  for (const name of fs.readdirSync(root).filter(name => name.endsWith(".selftest.sh"))) {
    fs.copyFileSync(path.join(root, name), path.join(scratch, name));
  }
  const name = "zzz-planted.selftest.sh", file = path.join(scratch, name);
  // Read-only source data: this intentionally unsafe setup is NEVER executed.
  const setup = 'FIX="$(selftest_make_fixture_dir ' + JSON.stringify(path.join(scratch, "unused.XXXXXX")) + ')"';
  fs.writeFileSync(file, '#!/usr/bin/env bash\n' + setup + '\nselftest_isolate_git "$FIX" || exit 2\n');
  assert(fs.statSync(file).isFile());
  assert.throws(() => auditDirectory(scratch), error => error instanceof Error &&
    error.message.includes(`${name}:2: fixture setup must end in || exit 2`),
    "unguarded fixture assignment was silently skipped");
  console.log(`PASS planted setup without || exit 2 rejected at ${name}:2 (following boundary present)`);
}

if (import.meta.main) {
  const [root, scratch] = process.argv.slice(2);
  console.log(`PASS fixture Git boundary audit (${auditDirectory(root)} suite setups)`);
  regression(root, scratch);
}
