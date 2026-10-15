import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ChannelKind } from "../channels";

export class NoChannelCredential extends Error {}

export function credentialSetup(kind: ChannelKind): string {
  return `set WHEELHOUSE_${kind.toUpperCase()}_TOKEN or provision seats/run/${kind}.token (mode 0600)` +
    (kind === "teams" ? "; with no token file, alternatively set WHEELHOUSE_TEAMS_TOKEN_CMD to a command whose stdout is a fresh bearer token" : "");
}

// Shared by the presence check and transports: same precedence, no network,
// no credential values in diagnostics. Never expose TOKEN_CMD stdout/stderr
// or its command line through an execFileSync exception.
export function channelToken(root: string, kind: ChannelKind): string {
  const env = process.env[`WHEELHOUSE_${kind.toUpperCase()}_TOKEN`]?.trim();
  if (env) return env;
  const file = path.join(root, "seats", "run", `${kind}.token`);
  const fix = credentialSetup(kind);
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) throw new Error(`${kind} token file must be mode 0600, got ${mode.toString(8)}; ${fix}`);
    let token: string;
    try { token = fs.readFileSync(file, "utf8").trim(); }
    catch { throw new Error(`${kind} token file could not be read; ${fix}`); }
    if (token) return token;
    throw new NoChannelCredential(`${kind} token file is empty; ${fix}`);
  }
  if (kind === "teams" && process.env.WHEELHOUSE_TEAMS_TOKEN_CMD) {
    let token: string;
    try {
      token = execFileSync("bash", ["-lc", process.env.WHEELHOUSE_TEAMS_TOKEN_CMD], {
        encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch { throw new Error(`teams token command failed; ${fix}`); }
    if (token) return token;
    throw new NoChannelCredential(`teams token command returned no token; ${fix}`);
  }
  throw new NoChannelCredential(`no ${kind} token configured; ${fix}`);
}
