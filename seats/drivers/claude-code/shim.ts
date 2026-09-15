#!/usr/bin/env bun
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function requiredArg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}
function optionalArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
function appendJson(file: string, obj: any): void {
  fs.appendFileSync(file, JSON.stringify({ timestamp: Date.now(), ...obj }) + "\n");
}
function projectsRoot(): string {
  const root = defaultLogin ? path.join(os.homedir(), ".claude") : accountDir;
  return path.join(root, "projects");
}
function findSessionFile(id: string): string | null {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  const want = `${id}.jsonl`;
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === want) return full;
      if (ent.isDirectory()) stack.push(full);
    }
  }
  return null;
}
function waitForSessionFile(id: string, ms = Number(process.env.WHEELHOUSE_CLAUDE_SESSION_LOCATE_MS || 2000)): string | null {
  const deadline = Date.now() + ms;
  let found: string | null = null;
  do {
    found = findSessionFile(id);
    if (found) return found;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  } while (Date.now() < deadline);
  return null;
}

const log = requiredArg("log");
const rawLog = requiredArg("raw-log");
const errLog = requiredArg("err-log");
const accountDir = requiredArg("account-dir");
const briefPath = requiredArg("brief");
const briefText = fs.readFileSync(briefPath, "utf8");
const model = requiredArg("model");
const cwd = requiredArg("cwd");
const actor = requiredArg("actor");
const resumeRef = optionalArg("resume");
const defaultLogin = process.argv.includes("--default-login");
const permissionMode = optionalArg("permission-mode") || "acceptEdits";
const allowedTools = optionalArg("allowed-tools");

fs.mkdirSync(path.dirname(log), { recursive: true });
fs.mkdirSync(accountDir, { recursive: true });

const env: NodeJS.ProcessEnv = { ...process.env, BEADS_ACTOR: actor };
if (defaultLogin) delete env.CLAUDE_CONFIG_DIR;
else env.CLAUDE_CONFIG_DIR = accountDir;
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.OPENAI_API_KEY;

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--model", model,
  "--append-system-prompt", briefText,
  "--setting-sources", "project",
  "--permission-mode", permissionMode,
  "--permission-prompts", "none",
];
if (allowedTools) args.push("--allowedTools", allowedTools);
if (resumeRef) args.push("--resume", path.basename(resumeRef, ".jsonl"));

const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

let sessionId: string | null = resumeRef ? path.basename(resumeRef, ".jsonl") : null;
let sessionFile: string | null = sessionId ? findSessionFile(sessionId) : null;
let resolvedModel = model;
let streaming = false;
let stdoutBuffer = "";
let fifoBuffer = "";
let pendingPromptResponses: any[] = [];
let currentAssistantContent: any[] = [];
let turnEndEmitted = false;
let capacityErrorEmitted = false;
const toolNames = new Map<string, string>();

function sendResponse(id: any, success: boolean, data?: any, error?: string): void {
  appendJson(log, { type: "response", id, success, ...(success ? { data } : { error }) });
}
function responseState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { isStreaming: streaming, sessionId, sessionFile, model: resolvedModel, ...extra };
}
function contentFromParts(parts: any[]): any[] {
  const content: any[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") content.push({ type: "text", text: part.text ?? "" });
    else if (part.type === "thinking") content.push({ type: "thinking", thinking: part.thinking ?? part.text ?? "" });
    else if (part.type === "tool_use") {
      const args = part.input ?? {};
      if (part.id) toolNames.set(String(part.id), String(part.name ?? ""));
      content.push({ type: "toolCall", id: part.id, name: part.name, args });
      appendJson(log, { type: "tool_execution_start", toolCallId: part.id, toolName: part.name, args });
    }
  }
  return content;
}
function emitToolResultEnd(parts: any[]): void {
  for (const part of parts) {
    if (part?.type !== "tool_result") continue;
    appendJson(log, {
      type: "tool_execution_end",
      toolCallId: part.tool_use_id,
      toolName: part.name ?? toolNames.get(String(part.tool_use_id)) ?? null,
      result: { isError: Boolean(part.is_error), content: part.content ?? part.text ?? "" },
    });
  }
}
function emitTurnEnd(): void {
  if (turnEndEmitted) return;
  turnEndEmitted = true;
  appendJson(log, { type: "turn_end", message: { role: "assistant", content: currentAssistantContent } });
}

child.stderr.on("data", (chunk) => fs.appendFileSync(errLog, chunk));
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  let i: number;
  while ((i = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, i);
    stdoutBuffer = stdoutBuffer.slice(i + 1);
    if (!line.trim()) continue;
    fs.appendFileSync(rawLog, line + "\n");
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }

    if (ev.type === "rate_limit_event") {
      const info = ev.rate_limit_info ?? {};
      if (info.status && info.status !== "allowed" && !capacityErrorEmitted) {
        capacityErrorEmitted = true;
        const text = JSON.stringify(info);
        appendJson(log, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "error", error: text } });
      }
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      sessionId = ev.session_id || sessionId;
      resolvedModel = ev.model || resolvedModel;
      if (sessionId) sessionFile = waitForSessionFile(sessionId);
      if (streaming) appendJson(log, { type: "agent_start" });
      for (const id of pendingPromptResponses.splice(0)) sendResponse(id, true, responseState({ delivered: true }));
      continue;
    }
    if (ev.type === "assistant") {
      currentAssistantContent = contentFromParts(ev.message?.content ?? ev.content ?? []);
      appendJson(log, { type: "message_end", message: { role: "assistant", content: currentAssistantContent } });
      continue;
    }
    if (ev.type === "user") {
      emitToolResultEnd(ev.message?.content ?? ev.content ?? []);
      continue;
    }
    if (ev.type === "result") {
      streaming = false;
      if (sessionId && !sessionFile) sessionFile = waitForSessionFile(sessionId);
      emitTurnEnd();
      const ok = ev.subtype === "success" && !ev.is_error;
      const stopReason = ok ? "stop" : ev.subtype === "error_during_execution" ? "aborted" : "error";
      const finalText = ev.result ?? currentAssistantContent.map((p) => p.text || p.thinking || "").filter(Boolean).join("\n") ?? "";
      appendJson(log, { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: finalText }], stopReason }], ...(ok ? {} : { error: finalText || ev.stop_reason || ev.subtype || "claude error" }) });
    }
  }
});

function sendUser(id: any, message: string): void {
  streaming = true;
  turnEndEmitted = false;
  capacityErrorEmitted = false;
  currentAssistantContent = [];
  appendJson(log, { type: "message_end", message: { role: "user", content: [{ type: "text", text: message }] } });
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: message }] } }) + "\n");
  if (sessionId) sendResponse(id, true, responseState({ delivered: true }));
  else pendingPromptResponses.push(id);
}

process.stdin.on("data", (chunk) => {
  fifoBuffer += chunk.toString("utf8");
  let i: number;
  while ((i = fifoBuffer.indexOf("\n")) >= 0) {
    const line = fifoBuffer.slice(0, i);
    fifoBuffer = fifoBuffer.slice(i + 1);
    if (!line.trim()) continue;
    let cmd: any;
    try { cmd = JSON.parse(line); } catch (e: any) { sendResponse(null, false, undefined, String(e)); continue; }
    if (cmd.type === "get_state") sendResponse(cmd.id, true, responseState());
    else if (cmd.type === "prompt" || cmd.type === "steer") sendUser(cmd.id, cmd.message || "");
    else sendResponse(cmd.id, false, undefined, `unknown command ${cmd.type}`);
  }
});

process.on("SIGTERM", () => {
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGTERM"); } catch {} process.exit(143); }, Number(process.env.WHEELHOUSE_CLAUDE_STOP_GRACE_MS || 500));
});
child.on("exit", (code, sig) => process.exit(sig ? 143 : (code ?? 0)));
