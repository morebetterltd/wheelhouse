import * as fs from "node:fs";
import * as path from "node:path";
import { readEvents } from "../needs";
import type { NeedTransport, OutboundNeedEvent, TransportPollResult } from "./transport";

export class NoSlackTransport extends Error {}

function now(){ return new Date().toISOString(); }
function tokenFrom(root: string): string {
  if (process.env.WHEELHOUSE_SLACK_TOKEN) return process.env.WHEELHOUSE_SLACK_TOKEN;
  const f = path.join(root, "seats", "run", "slack.token");
  if (!fs.existsSync(f)) throw new NoSlackTransport("no slack token configured");
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

export class SlackTransport implements NeedTransport {
  name = "slack";
  root: string;
  token: string;
  channel: string;
  allow: Set<string>;
  apiBase: string;
  constructor(root: string){
    this.root = root;
    this.token = tokenFrom(root);
    this.channel = channelFrom(root);
    this.allow = allowedFrom(root);
    this.apiBase = (process.env.WHEELHOUSE_SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
  }
  endpoint(method: string): string { return `${this.apiBase}/${method}`; }
  async call(method: string, body: any): Promise<any> {
    const res = await fetch(this.endpoint(method), { method:"POST", headers:{"content-type":"application/json", "authorization":`Bearer ${this.token}`}, body:JSON.stringify(body) });
    const json:any = await res.json().catch(()=>({ok:false, error:`HTTP ${res.status}`}));
    if (!res.ok || json.ok === false) throw new Error(json.error || json.description || `slack ${method} failed`);
    return json;
  }
  text(ev: OutboundNeedEvent): string {
    if (ev.type === "opened") return `${ev.title}\n\n${ev.body}${ev.options?.length ? `\n\nOptions: ${ev.options.map((o,i)=>`${i+1}) ${o.label}: ${o.text}`).join("; ")}` : ""}`;
    if (ev.type === "message") return ev.text;
    return `Resolved: ${ev.reason}`;
  }
  async confirm(ts: string, threadTs?: string): Promise<void> {
    const method = threadTs ? "conversations.replies" : "conversations.history";
    const body:any = { channel:this.channel, limit:20 };
    if (threadTs) body.ts = threadTs;
    else { body.latest = ts; body.inclusive = true; }
    const json = await this.call(method, body);
    const messages:any[] = json.messages || [];
    if (!messages.some(m => String(m.ts) === String(ts))) throw new Error(`slack send unverified: ${method} did not return ts ${ts}`);
  }
  async send(ev: OutboundNeedEvent): Promise<{ref:string}> {
    const prior = slackRefs().get(ev.id);
    const threadTs = prior && ev.type !== "opened" ? prior.split(":").pop() : undefined;
    const body:any = { channel:this.channel, text:this.text(ev) };
    if (threadTs) body.thread_ts = threadTs;
    const json = await this.call("chat.postMessage", body);
    const ts = String(json.ts || json.message?.ts || "");
    if (!ts) throw new Error("slack send unverified: chat.postMessage returned no ts");
    await this.confirm(ts, threadTs);
    return { ref: `${this.channel}:${ts}` };
  }
  async poll(cursor?: string): Promise<TransportPollResult> {
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
