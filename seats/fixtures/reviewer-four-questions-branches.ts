// Input-only packet for reviewer-owned W9 real-seat runs. Never launches a seat.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command.ts";
const [destination] = process.argv.slice(2), source = path.resolve(import.meta.dir, "../..");
assert(destination, "usage: bun reviewer-four-questions-branches.ts <new per-bead scratch directory>");
const root = path.resolve(destination); assert(!fs.existsSync(root), "refuse to adopt an existing packet");
for (const d of [root, "install/seats", "install/contracts", "product/seats", "bin", "tmp"]) fs.mkdirSync(path.resolve(root, d), { recursive: true });
const install = path.join(root, "install"), product = path.join(root, "product"), commands: any[] = [];
function git(cwd: string, ...args: string[]) {
  const r = completedCommand("git", args, { cwd }); commands.push({ cwd, args, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
  fs.writeFileSync(path.join(root, "commands.json"), JSON.stringify(commands, null, 2) + "\n"); assert.equal(r.status, 0, r.stderr); assert.equal(r.signal, null); assert(!r.error); return r.stdout.trim();
}
for (const f of fs.readdirSync(path.join(source, "seats"))) if (/\.(ts|sh)$/.test(f) && !f.endsWith(".selftest.sh")) fs.copyFileSync(path.join(source, "seats", f), path.join(install, "seats", f));
for (const dir of ["drivers", "transports"]) fs.cpSync(path.join(source, "seats", dir), path.join(install, "seats", dir), { recursive: true });
fs.copyFileSync(path.join(source, "contracts/REVIEWER.md"), path.join(install, "contracts/REVIEWER.md"));
for (const f of ["selftest-core.list", "selftest-sweep.sh", "selftest-sweep-lock.ts", "native-command.ts", "completed-command.ts", "python-invocations.ts"]) {
  if (f === "selftest-core.list") fs.writeFileSync(path.join(product, "seats", f), "fixture.selftest.sh\n");
  else fs.copyFileSync(path.join(source, "seats", f), path.join(product, "seats", f));
}
fs.writeFileSync(path.join(product, "seats/fixture.selftest.sh"), '#!/usr/bin/env bash\nset -eu\ntest "$(cat message.txt)" = ready\nprintf "fixture message PASS\\n"\n');
fs.writeFileSync(path.join(product, "message.txt"), "pending\n"); fs.writeFileSync(path.join(product, "unrelated.txt"), "unchanged reference\n");
git(product, "init", "-q", "-b", "main"); git(product, "add", "seats", "message.txt", "unrelated.txt");
const commit = (cwd: string, msg: string) => { git(cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "-c", "commit.gpgsign=false", "commit", "-qm", msg); return git(cwd, "rev-parse", "HEAD"); };
const base = commit(product, "private W9 review fixture base");
git(product, "checkout", "-qb", "fleet/positive"); fs.writeFileSync(path.join(product, "message.txt"), "ready\n"); git(product, "add", "message.txt"); const positive = commit(product, "set contracted message ready");
git(product, "checkout", "-qb", "fleet/scope-defect"); fs.writeFileSync(path.join(product, "unrelated.txt"), "unrequested reference edit\n"); git(product, "add", "unrelated.txt"); const defect = commit(product, "also edit a file outside the contract"); git(product, "checkout", "-q", "main");
const contract = `Trace: W9 four-question real reviewer fixture
Signal: isa-gap: W9
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Set the message file to ready, without altering the unrelated reference file or the test machinery.

Outcomes:
- O1 The message is ready.
  consumer: machine — the fixture message reader
  surface: message.txt
  check: run — read message.txt; its entire content is ready followed by one newline
`;
fs.writeFileSync(path.join(root, "contract.md"), contract);
// Claim reads are deterministic fixture input. All graph writes stay with the
// real bd in the dispatcher's owned scratch graph, never with a production DB.
fs.writeFileSync(path.join(root, "bin/bd"), `#!/usr/bin/env bash
set -eu
case "\${1:-}" in show) case "\${2:-}" in w9-positive|w9-scope-defect) exec /bin/cat ${JSON.stringify(path.join(root, "contract.md"))};; esac;; esac
case "$PWD/" in ${JSON.stringify(root)}/*) ;; *) echo 'fixture bd refuses a cwd outside its owned packet' >&2; exit 2;; esac
exec "\${W9_REAL_BD:?set the real bd path before prepending this fixture bin}" "$@"
`, { mode: 0o755 });
git(install, "init", "-q", "-b", "main"); git(install, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "isolated review install");
assert.equal(git(product, "diff", "--name-only", base, positive), "message.txt");
assert.equal(git(product, "diff", "--name-only", base, defect), "message.txt\nunrelated.txt");
assert.equal(git(product, "show", positive + ":message.txt"), "ready");
assert.equal(git(product, "show", defect + ":unrelated.txt"), "unrequested reference edit");
fs.writeFileSync(path.join(root, "packet.json"), JSON.stringify({ inputOnly: true, noSeatLaunched: true, install, product, base, positive, defect, contract: path.join(root, "contract.md"), expected: { positive: { code: 0, verdict: "APPROVE", questions: "four OK with actual inline evidence" }, defect: { code: 2, verdict: "BOUNCE", scope: "DEFECT naming unrelated.txt" } } }, null, 2) + "\n");
console.log("PREPARED input-only W9 branches: positive=" + positive + " scope-defect=" + defect + "; no seat launched");
