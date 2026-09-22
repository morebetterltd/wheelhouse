import * as fs from "node:fs";
import * as path from "node:path";
import { fold, readEvents, type NeedEvent } from "../needs";
import type { NeedTransport, OutboundNeedEvent, TransportPollResult } from "./transport";

export class NoTelegramTransport extends Error {}

function now(){ return new Date().toISOString(); }
function tokenFrom(root: string): string {
  if (process.env.WHEELHOUSE_TELEGRAM_TOKEN) return process.env.WHEELHOUSE_TELEGRAM_TOKEN;
  const f = path.join(root, "seats", "run", "telegram.token");
  if (!fs.existsSync(f)) throw new NoTelegramTransport("no telegram token configured");
  const mode = fs.statSync(f).mode & 0o777;
  if (mode !== 0o600) throw new Error(`telegram token file must be mode 0600, got ${mode.toString(8)}`);
  return fs.readFileSync(f, "utf8").trim();
}
function allowFile(root: string): string { return path.join(root, "seats", "run", "telegram.allow"); }
function allowEntries(root: string): string[] {
  const f = allowFile(root);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f,"utf8").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
}
function allowedFrom(root: string): Set<string> {
  const out = new Set<string>();
  for (const line of allowEntries(root)) for (const part of line.split(/\s+/)) if (part && !part.startsWith("@")) out.add(part);
  return out;
}
function allowedUsernames(root: string): Set<string> {
  const out = new Set<string>();
  for (const line of allowEntries(root)) for (const part of line.split(/\s+/)) if (part.startsWith("@")) out.add(part.toLowerCase());
  return out;
}
function appendPairing(root: string, username: string, id: string){
  const f = allowFile(root); fs.mkdirSync(path.dirname(f), { recursive:true });
  const lines = allowEntries(root);
  if (!lines.some(l => l.split(/\s+/).includes(id))) fs.appendFileSync(f, `${username} ${id}\n`);
}
function log(root: string, line: string){ const dir=path.join(root,"seats","logs"); fs.mkdirSync(dir,{recursive:true}); fs.appendFileSync(path.join(dir,"courier.out.log"), `${new Date().toISOString()} ${line}\n`); }
function sentRefByNeed(): Map<string,string> { const m=new Map<string,string>(); for(const ev of readEvents() as any[]){ if(ev?.type==="sent" && ev.transport==="telegram" && typeof ev.id==="string" && typeof ev.ref==="string") m.set(ev.id, ev.ref); } return m; }
function needByMessageId(): Map<string,string> { const m=new Map<string,string>(); for(const [id,ref] of sentRefByNeed()) { const msg=ref.split(":").pop(); if(msg) m.set(msg,id); } return m; }
function openNeedIds(): string[] { return Array.from(fold().values()).filter(n=>n.state==="open").map(n=>n.id); }
function abortMs(method: string, body: any): number {
  const override = Number(process.env.WHEELHOUSE_TELEGRAM_FETCH_ABORT_MS || "0");
  if (Number.isFinite(override) && override > 0) return override;
  if (method === "getUpdates") return (Number(body?.timeout ?? 25) * 1000) + 10000;
  return 10000;
}
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

export class TelegramTransport implements NeedTransport {
  name = "telegram";
  root: string;
  token: string;
  allow: Set<string>;
  apiBase: string;
  chatId: string;
  usernames: Set<string>;
  constructor(root: string){
    this.root = root;
    this.token = tokenFrom(root);
    this.allow = allowedFrom(root);
    this.usernames = allowedUsernames(root);
    this.apiBase = (process.env.WHEELHOUSE_TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
    this.chatId = process.env.WHEELHOUSE_TELEGRAM_CHAT_ID || Array.from(this.allow)[0] || Array.from(this.usernames)[0] || "";
    if (!this.chatId) throw new Error("telegram.allow must name at least one chat/user id or @username, or set WHEELHOUSE_TELEGRAM_CHAT_ID");
  }
  endpoint(method: string): string { return `${this.apiBase}/bot${this.token}/${method}`; }
  async call(method: string, body: any): Promise<any> {
    const timeoutMs = abortMs(method, body);
    const res = await fetchWithTimeout(this.endpoint(method), { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) }, timeoutMs, `telegram ${method}`);
    const json:any = await res.json().catch(()=>({ok:false, description:`HTTP ${res.status}`}));
    if (!res.ok || json.ok === false) throw new Error(json.description || `telegram ${method} failed`);
    return json.result;
  }
  text(ev: OutboundNeedEvent): string {
    if (ev.type === "opened") return `${ev.title}\n\n${ev.body}${ev.options?.length ? `\n\nOptions: ${ev.options.map((o,i)=>`${i+1}) ${o.label}: ${o.text}`).join("; ")}` : ""}`;
    if (ev.type === "message") return ev.text;
    return `Resolved: ${ev.reason}`;
  }
  async send(ev: OutboundNeedEvent): Promise<{ref:string}> {
    const sent = sentRefByNeed();
    const prior = sent.get(ev.id);
    const chat = this.chatId.startsWith("@") ? Array.from(this.allow)[0] : this.chatId;
    if (!chat) throw new Error(`waiting for ${this.chatId} to message the bot`);
    const body:any = { chat_id:chat, text:this.text(ev) };
    if (prior && ev.type !== "opened") body.reply_to_message_id = Number(prior.split(":").pop());
    const result = await this.call("sendMessage", body);
    return { ref: `${result.chat?.id ?? chat}:${result.message_id}` };
  }
  async poll(cursor?: string): Promise<TransportPollResult> {
    const body:any = { timeout: Number(process.env.WHEELHOUSE_TELEGRAM_POLL_TIMEOUT || "25") };
    if (cursor) body.offset = Number(cursor);
    const updates:any[] = await this.call("getUpdates", body);
    const byMsg = needByMessageId();
    const replies:any[] = [];
    let next = cursor || "";
    for (const upd of updates || []) {
      if (typeof upd.update_id === "number") next = String(Math.max(Number(next || 0), upd.update_id + 1));
      const msg = upd.message;
      if (!msg || typeof msg.text !== "string") continue;
      const from = String(msg.from?.id ?? "");
      const username = msg.from?.username ? `@${String(msg.from.username).replace(/^@/, "")}`.toLowerCase() : "";
      if (username && this.usernames.has(username) && from && !this.allow.has(from)) {
        appendPairing(this.root, username, from);
        this.allow.add(from);
        if (this.chatId === username || this.chatId.startsWith("@")) this.chatId = from;
        log(this.root, `paired ${username} -> ${from}`);
      }
      if (this.allow.size && !this.allow.has(from)) { log(this.root, `ignored telegram sender ${from || "unknown"}`); continue; }
      let needRef = "";
      const replyId = msg.reply_to_message?.message_id;
      if (replyId !== undefined) needRef = byMsg.get(String(replyId)) || "";
      if (!needRef) { const open=openNeedIds(); if (open.length === 1) needRef = open[0]; }
      if (!needRef) { await this.call("sendMessage", { chat_id: msg.chat?.id ?? this.chatId, text: "reply to the message you're answering" }).catch(()=>{}); continue; }
      replies.push({ needRef, text: msg.text, from, at: msg.date ? new Date(msg.date*1000).toISOString() : now() });
    }
    return { replies, cursor: next };
  }
}

export type SentNeedEvent = { type:"sent"; id:string; at:string; transport:string; ref:string };
