import type { HarnessName } from "./harness";

export interface FinalLineCandidate {
  line: string;
  normalized: string;
  lineNumber: number;
}

function collectMessageText(value: unknown, out: string[]): void {
  if (value == null) return;
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectMessageText(v, out); return; }
  if (typeof value === "object") {
    const obj: any = value;
    if (typeof obj.role === "string" && obj.role !== "assistant") return;
    collectMessageText(obj.text, out);
    collectMessageText(obj.content, out);
  }
}

function messageRole(event: any): string | undefined {
  return event?.message?.role ?? event?.role ?? event?.message?.author?.role ?? event?.author?.role;
}

function eventText(event: any): string {
  const texts: string[] = [];
  collectMessageText(event?.message?.content ?? event?.content ?? event?.message ?? event?.text, texts);
  return texts.join("");
}

export function finalAssistantText(stdout: string, harness: HarnessName): string {
  let finalText: string | null = null;
  let sawStructuredMessage = false;
  let piCurrentRole: string | undefined;
  let piStreamText = "";
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(raw);
      if (harness === "pi") {
        if (event?.type === "message_start") {
          sawStructuredMessage = true;
          piCurrentRole = messageRole(event);
          if (piCurrentRole === "assistant") {
            piStreamText = eventText(event);
            if (piStreamText) finalText = piStreamText;
          }
          continue;
        }
        if (event?.type === "message_update") {
          sawStructuredMessage = true;
          const ev = event.assistantMessageEvent ?? event.delta ?? event;
          const evType = typeof ev?.type === "string" ? ev.type : "";
          const delta = evType === "text_delta" && typeof ev?.delta === "string" ? ev.delta : "";
          const content = evType === "text_end" && typeof ev?.content === "string" ? ev.content : "";
          if (delta) piStreamText += delta;
          if (content) piStreamText = content;
          if (piStreamText && (piCurrentRole === "assistant" || event.assistantMessageEvent)) finalText = piStreamText;
          continue;
        }
        if (event?.type === "text_delta" || event?.type === "text_end") {
          sawStructuredMessage = true;
          const delta = event.type === "text_delta" && typeof event?.delta === "string" ? event.delta : "";
          const content = event.type === "text_end" ? (typeof event?.text === "string" ? event.text : typeof event?.content === "string" ? event.content : "") : "";
          if (delta) piStreamText += delta;
          if (content) piStreamText = content;
          if (piStreamText && (!piCurrentRole || piCurrentRole === "assistant")) finalText = piStreamText;
          continue;
        }
        if (event?.type !== "message_end" && event?.type !== "turn_end") continue;
        sawStructuredMessage = true;
        const role = messageRole(event);
        if (role !== "assistant") continue;
        piCurrentRole = role;
        const text = eventText(event);
        if (text) finalText = text;
        else if (piStreamText) finalText = piStreamText;
      } else if (harness === "claude-code") {
        if (event?.type !== "assistant") continue;
        sawStructuredMessage = true;
        finalText = eventText(event);
      } else {
        if (event?.type !== "item.completed" || event?.item?.type !== "agent_message") continue;
        sawStructuredMessage = true;
        finalText = eventText(event.item);
      }
    } catch { /* ignore non-event prose and malformed JSON */ }
  }
  if (finalText !== null) return finalText;
  return sawStructuredMessage ? "" : stdout;
}

export function finalAssistantMessageLines(stdout: string, harness: HarnessName): string[] {
  return finalAssistantText(stdout, harness).split(/\r?\n/);
}

export function dedupeCandidates(candidates: FinalLineCandidate[]): FinalLineCandidate[] {
  const seen = new Set<string>();
  const out: FinalLineCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.normalized)) continue;
    seen.add(candidate.normalized);
    out.push(candidate);
  }
  return out;
}

export function liveLineCandidates(stdout: string, harness: HarnessName, tag: string): FinalLineCandidate[] {
  const out: FinalLineCandidate[] = [];
  let inFence = false;
  const lines = finalAssistantMessageLines(stdout, harness);
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}:`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const normalized = trimmed.replace(/^(>\s*)+/, "").trim();
    if (re.test(normalized)) out.push({ line, normalized, lineNumber: i + 1 });
  }
  return dedupeCandidates(out);
}
