import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [runtime, root, mode] = process.argv.slice(2);
assert.equal(process.env.CAPTURE_ROOT, root, "fixture environment must exist before Bun starts");
assert(fs.statSync(path.join(runtime, "seats/digest.ts")).isFile());
const calls = path.join(root, "bd-calls.jsonl");
const before = fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;
const { buildDigest } = await import(pathToFileURL(path.join(runtime, "seats/digest.ts")).href);
const digest = buildDigest("2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
const after = fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;
assert.equal(after - before, 2, "both consumer commands must reach the intended native provider");
console.log(JSON.stringify({ mode, providerCalls: after - before, unavailable: digest.shipped.some((x: any) => x.unavailable), shipped: digest.shipped.length, diagnostic: digest.shipped.find((x: any) => x.unavailable)?.diagnostic ?? null }));
