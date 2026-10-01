import * as fs from "node:fs";
import * as path from "node:path";
import { readEvents } from "../needs";
import type { ChannelTransport, InboundMessage, NeedTransport, OutboundNeedEvent, TransportPollResult } from "./transport";

export class NoSlackTransport extends Error {}

function now(){ return new Date().toISOString(); }
function tokenFrom(root: string): string {
  if (process.env.WHEELHOUSE_SLACK_TOKEN) return process.env.WHEELHOUSE_SLACK_TOKEN;
  const f = path.join(root, "seats", "run", "slack.token");
  if (!fs.existsSync(f)) throw new NoSlackTransport(`no slack token configured at ${f}`);
  const mode = fs.statSync(f).mode & 0o777;
  if (mode !== 0o600) throw new Error(`slack token file must be mode 0600, got ${mode.toString(8)}`);
  return fs.readFileSync(f, "utf8").trim();
}
function channelFrom(root: string): string {
  const v = process.env.WHEELHOUSE_SLACK_CHANNEL;
  if (v) return v;
  const f = path.join(root, "seats", "run", "slack.channel");
  if (!fs.existsSync(f)) throw new Error("slack.channel must name a channel id or set WHEELHOUSE_SLACK_CHANNEL");
  const channel = fs.readFileSync(f, "utf8").trim();
  if (!channel) throw new Error("slack.channel is empty");
  return channel;
}
function allowedFrom(root: string): Set<string> {
  const f = path.join(root, "seats", "run", "slack.allow");
  if (!fs.existsSync(f)) return new Set();
  return new Set(fs.readFileSync(f,"utf8").split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
}
function log(root: string, line: string){ const dir=path.join(root,"seats","logs"); fs.mkdirSync(dir,{recursive:true}); fs.appendFileSync(path.join(dir,"courier.out.log"), `${new Date().toISOString()} ${line}\n`); }
function slackRefs(): Map<string,string> { const m=new Map<string,string>(); for(const ev of readEvents() as any[]){ if(ev?.type==="sent" && ev.transport==="slack" && typeof ev.id==="string" && typeof ev.ref==="string") m.set(ev.id, ev.ref); } return m; }
function needByThreadTs(): Map<string,string> { const m=new Map<string,string>(); for(const [id,ref] of slackRefs()) { const parts=ref.split(":"); const ts=parts[parts.length-1]; if(ts) m.set(ts,id); } return m; }
function abortMs(): number { const n=Number(process.env.WHEELHOUSE_SLACK_FETCH_ABORT_MS || "10000"); return Number.isFinite(n) && n > 0 ? n : 10000; }
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export class SlackTransport implements NeedTransport, ChannelTransport {
  name = "slack";
  kind = "slack" as const;
  root: string;
  token: string;
  channel: string;
  allow: Set<string>;
  apiBase: string;
  constructor(root: string, opts: { destination?: string; allow?: string[] } = {}){
    this.root = root;
    this.token = tokenFrom(root);
    this.channel = opts.destination ?? (process.env.WHEELHOUSE_SLACK_CHANNEL || (fs.existsSync(path.join(root, "seats", "run", "slack.channel")) ? fs.readFileSync(path.join(root, "seats", "run", "slack.channel"), "utf8").trim() : ""));
    this.allow = opts.destination !== undefined ? new Set(opts.allow || []) : allowedFrom(root);
    this.apiBase = (process.env.WHEELHOUSE_SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
  }
  endpoint(method: string): string { return `${this.apiBase}/${method}`; }
  async call(method: string, body: any): Promise<any> {
    const timeoutMs = abortMs();
    const res = await fetchWithTimeout(this.endpoint(method), { method:"POST", headers:{"content-type":"application/json", "authorization":`Bearer ${this.token}`}, body:JSON.stringify(body) }, timeoutMs, `slack ${method}`);
    const json:any = await res.json().catch(()=>({ok:false, error:`HTTP ${res.status}`}));
    if (!res.ok || json.ok === false) throw new Error(json.error || json.description || `slack ${method} failed`);
    return json;
  }
  text(ev: OutboundNeedEvent): string {
    if (ev.type === "opened") return `${ev.title}\n\n${ev.body}${ev.options?.length ? `\n\nOptions: ${ev.options.map((o,i)=>`${i+1}) ${o.label}: ${o.text}`).join("; ")}` : ""}`;
    if (ev.type === "message") return ev.text;
    return `Resolved: ${ev.reason}`;
  }
  async readBack(destination: string, ref: string, text: string): Promise<boolean> {
    const parts = ref.split(":");
    const ts = parts.pop() || ref;
    const threadTs = parts.length > 1 ? parts.pop() : undefined;
    const method = threadTs ? "conversations.replies" : "conversations.history";
    const body:any = { channel:destination, limit:20 };
    if (threadTs) body.ts = threadTs;
    else { body.latest = ts; body.inclusive = true; }
    const json = await this.call(method, body);
    const messages:any[] = json.messages || [];
    return messages.some(m => String(m.ts) === String(ts) && (text === undefined || String(m.text ?? "") === text));
  }
  async confirm(ts: string, threadTs?: string): Promise<void> {
    const ok = await this.readBack(this.channel, threadTs ? `${this.channel}:${threadTs}:${ts}` : `${this.channel}:${ts}`, undefined as any);
    if (!ok) throw new Error(`slack send unverified: did not return ts ${ts}`);
  }
  async post(destination: string, text: string, opts: { threadRef?: string } = {}): Promise<{ref:string; readBack:"fetched"}> {
    const body:any = { channel:destination, text };
    if (opts.threadRef) body.thread_ts = opts.threadRef;
    const json = await this.call("chat.postMessage", body);
    const ts = String(json.ts || json.message?.ts || "");
    if (!ts) throw new Error("slack send unverified: chat.postMessage returned no ts");
    const ref = opts.threadRef ? `${destination}:${opts.threadRef}:${ts}` : `${destination}:${ts}`;
    return { ref, readBack: "fetched" };
  }
  async send(ev: OutboundNeedEvent): Promise<{ref:string}> {
    if (!this.channel) this.channel = channelFrom(this.root);
    const prior = slackRefs().get(ev.id);
    const threadTs = prior && ev.type !== "opened" ? prior.split(":").pop() : undefined;
    const text = this.text(ev);
    const r = await this.post(this.channel, text, threadTs ? { threadRef: threadTs } : undefined);
    if (!(await this.readBack(this.channel, r.ref, text))) throw new Error(`slack send unverified: read-back did not return ${r.ref}`);
    return { ref: r.ref };
  }
  async read(destination: string, cursor?: string): Promise<{messages: InboundMessage[]; cursor: string}> {
    const json = await this.call("conversations.history", { channel:destination, oldest:cursor || "0", inclusive:false, limit:100 });
    const messages: InboundMessage[] = [];
    let next = cursor || "0";
    for (const msg of (json.messages || []).slice().reverse()) {
      const ts = String(msg.ts || "");
      if (ts && Number(ts) > Number(next || 0)) next = ts;
      if (!ts || msg.thread_ts && String(msg.thread_ts) !== ts || typeof msg.text !== "string") continue;
      messages.push({ ref: `${destination}:${ts}`, from: String(msg.user || ""), text: msg.text, at: msg.ts ? new Date(Number(msg.ts.split(".")[0])*1000).toISOString() : now(), threadRef: msg.thread_ts ? String(msg.thread_ts) : undefined });
    }
    return { messages, cursor: next };
  }
  async poll(cursor?: string): Promise<TransportPollResult> {
    if (!this.channel) this.channel = channelFrom(this.root);
    const json = await this.call("conversations.history", { channel:this.channel, oldest:cursor || "0", inclusive:false, limit:100 });
    const byThread = needByThreadTs();
    const replies:any[] = [];
    let next = cursor || "0";
    for (const msg of (json.messages || []).slice().reverse()) {
      const ts = String(msg.ts || "");
      if (ts && Number(ts) > Number(next || 0)) next = ts;
      const threadTs = msg.thread_ts ? String(msg.thread_ts) : "";
      if (!threadTs || threadTs === ts || typeof msg.text !== "string") continue;
      const user = String(msg.user || "");
      if (this.allow.size && !this.allow.has(user)) { log(this.root, `ignored slack sender ${user || "unknown"}`); continue; }
      const needRef = byThread.get(threadTs) || "";
      if (!needRef) continue;
      replies.push({ needRef, text: msg.text, from:user, at: msg.ts ? new Date(Number(msg.ts.split(".")[0])*1000).toISOString() : now() });
    }
    return { replies, cursor: next };
  }
}
