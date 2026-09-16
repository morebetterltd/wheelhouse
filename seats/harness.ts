import * as fs from "node:fs";

export const HARNESS_VALUES = ["pi", "claude-code", "codex"] as const;
export type HarnessName = (typeof HARNESS_VALUES)[number];

export function harnessNameForSeat(seatName: string, entry: { harness?: string } | undefined): HarnessName {
  const raw = entry?.harness ?? "pi";
  if ((HARNESS_VALUES as readonly string[]).includes(raw)) return raw as HarnessName;
  throw new Error(
    `seat "${seatName}" has invalid harness ${JSON.stringify(raw)} in seats/seats.json — ` +
      `must be one of ${HARNESS_VALUES.join(", ")} (or omitted for pi)`
  );
}

export function requirePiHarness(seatName: string, entry: { harness?: string } | undefined, operation: string): void {
  const harness = harnessNameForSeat(seatName, entry);
  if (harness !== "pi") {
    throw new Error(`seat "${seatName}" has harness=${JSON.stringify(harness)} in seats/seats.json; ${operation} is not implemented for that harness yet`);
  }
}

export function oneShotEnvForHarness(harness: HarnessName, accountDir: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PI_CODING_AGENT_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (harness === "pi") env.PI_CODING_AGENT_DIR = accountDir;
  else if (harness === "claude-code") env.CLAUDE_CONFIG_DIR = accountDir;
  else env.CODEX_HOME = accountDir;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function oneShotCommandForHarness(harness: HarnessName, brief: string, provider: string | undefined, model: string | undefined, prompt: string): { bin: string; args: string[]; display: string } {
  if (harness === "pi") {
    const args = ["-p", "--mode", "json", "--no-session", "--append-system-prompt", brief];
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    args.push(prompt);
    return { bin: "pi", args, display: `pi ${args.map((a) => (a === prompt ? "<prompt>" : a)).join(" ")}` };
  }
  if (harness === "claude-code") {
    const args = ["-p", "--output-format", "stream-json", "--append-system-prompt", brief];
    if (model) args.push("--model", model);
    args.push(prompt);
    return { bin: "claude", args, display: `claude ${args.map((a) => (a === prompt ? "<prompt>" : a)).join(" ")}` };
  }
  const briefText = fs.existsSync(brief) ? fs.readFileSync(brief, "utf8") : brief;
  const args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-c", "approval_policy=never", "-c", `developer_instructions=${JSON.stringify(briefText)}`];
  if (model) args.push("--model", model);
  args.push(prompt);
  return { bin: "codex", args, display: `codex ${args.map((a) => (a === prompt ? "<prompt>" : a)).join(" ")}` };
}
