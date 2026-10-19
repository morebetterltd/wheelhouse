// Exercise real CLI admission gates, never a provider or installed service.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = process.argv[2];
assert(fs.existsSync(path.join(root, ".git")), "fixture repository must exist");
const file = (name: string) => path.join(root, "seats", name);
const put = (name: string, value: unknown) => fs.writeFileSync(file(name), JSON.stringify(value));
const entry = (role: string, name: string) => ({ role, harness: "pi", provider: "openai", model: "fixture", account: { dir: path.join(root, "missing-" + name), authRoute: "env" } });
function roster(legacy = false) {
  fs.rmSync(file("pool.json"), { force: true }); fs.rmSync(file("staffing.json"), { force: true });
  // Walker first: automatic review selection must skip it, not just accept a reviewer by luck.
  put("seats.json", { seats: { verifier: entry("verifier", "walker"), author: entry("worker", "author"), "reviewer-1": entry(legacy ? "verifier" : "reviewer", "reviewer") } });
}
function cli(script: string, args: string[], code: number, ...text: string[]) {
  const result = spawnSync("bun", [file(script), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, WHEELHOUSE_ROOT: root } });
  assert.ifError(result.error);
  assert.equal(result.status, code, result.stdout + result.stderr);
  for (const wanted of text) assert((result.stdout + result.stderr).includes(wanted), `missing ${JSON.stringify(wanted)}: ${result.stdout}${result.stderr}`);
}
const review = ["fixture-bead", "main", "author"];
const walk = ["fixture-claim", "--surface", "product:echo inert", "--out", path.join(root, "walk-output")];
const cases: Record<string, () => void> = {
  "review auto selects reviewer only": () => { roster(); cli("verify.ts", review, 1, "reviewer seat directory does not exist:", "missing-reviewer"); },
  "review refuses explicit walker with named fix": () => { roster(); cli("verify.ts", [...review, "verifier"], 1, 'has role "verifier", not "reviewer"', 'seats["verifier"].role to "reviewer"'); },
  "walk auto selects verifier only": () => { roster(); cli("walk.ts", walk, 5, "verifier seat directory does not exist:", "missing-walker"); },
  "walk refuses explicit reviewer": () => { roster(); cli("walk.ts", [...walk, "--verifier", "reviewer-1"], 5, 'has role "reviewer", not "verifier"'); },
  "legacy fixed review seat gets named one-line fix": () => { roster(true); cli("verify.ts", review, 1, 'no seat with role "reviewer"', 'seat "reviewer-1"', 'seats["reviewer-1"].role to "reviewer"', 'keep "verifier" only for walk.ts'); },
  "pool reviewers coexist with fixed walker": () => {
    roster(); const fixed = JSON.parse(fs.readFileSync(file("seats.json"), "utf8")); delete fixed.seats["reviewer-1"]; put("seats.json", fixed);
    put("pool.json", { version: 1, entries: { r: { harness: "pi", provider: "openai", models: ["fixture"], account: { dir: path.join(root, "pool-account"), authRoute: "env" } } }, roles: { reviewers: { min: 0, max: 1, entries: ["r"], model: "fixture" } } });
    put("staffing.json", { version: 1, seats: { "reviewer-r": { role: "reviewer", entry: "r" } } });
    cli("verify.ts", review, 1, "reviewer seat directory does not exist:", "pool-account");
    cli("walk.ts", walk, 5, "verifier seat directory does not exist:", "missing-walker");
  },
  "legacy staffed review seat gets named one-line fix": () => {
    cases["pool reviewers coexist with fixed walker"]();
    put("staffing.json", { version: 1, seats: { "verifier-r": { role: "verifier", entry: "r" } } });
    cli("verify.ts", review, 1, 'seat verifier-r has invalid or legacy role "verifier"', 'seats["verifier-r"].role to "reviewer"');
  },
};
for (const [name, check] of Object.entries(cases)) { check(); console.log(`  ok    ${name}`); }

// Negative controls operate only on copied runtime files. Each new leg above
// must reject a role gate (or migration diagnostic) with its fix removed.
const mutants = [
  { file: "verify.ts", from: 'e.role === "reviewer"', to: 'e.role === "verifier"', tests: ["review auto selects reviewer only"] },
  { file: "verify.ts", from: 'entry.role !== "reviewer"', to: 'entry.role !== "verifier"', tests: ["review refuses explicit walker with named fix"] },
  { file: "walk.ts", from: 'e.role === "verifier"', to: 'e.role === "reviewer"', tests: ["walk auto selects verifier only"] },
  { file: "walk.ts", from: 'entry.role !== "verifier"', to: 'entry.role !== "reviewer"', tests: ["walk refuses explicit reviewer"] },
  { file: "verify.ts", from: '${legacy ? `\\n${legacy}` : ""}', to: '', tests: ["legacy fixed review seat gets named one-line fix"] },
  { file: "pool.ts", from: 'return role === "workers" ? "worker" : "reviewer"', to: 'return role === "workers" ? "worker" : "verifier"', tests: ["pool reviewers coexist with fixed walker"] },
  { file: "roster.ts", from: 'if (seat.role === "reviewer") return "reviewers";', to: 'if (seat.role === "reviewer" || (seat as any).role === "verifier") return "reviewers";', tests: ["legacy staffed review seat gets named one-line fix"] },
];
for (const mutant of mutants) {
  const source = fs.readFileSync(file(mutant.file), "utf8");
  assert(source.includes(mutant.from), `canary anchor missing: ${mutant.file}: ${mutant.from}`);
  fs.writeFileSync(file(mutant.file), source.replace(mutant.from, mutant.to));
  try {
    for (const name of mutant.tests) {
      let rejected = false; try { cases[name](); } catch { rejected = true; }
      assert(rejected, `regression passed with fix removed: ${name}`);
      console.log(`  ok    negative control fails with fix removed: ${name}`);
    }
  } finally { fs.writeFileSync(file(mutant.file), source); }
}
console.log("role-split selftest: PASS (7 legs, 7 negative controls)");
