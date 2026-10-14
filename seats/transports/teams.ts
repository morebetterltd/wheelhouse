import { channelToken, NoChannelCredential } from "./credentials";
import type { ChannelTransport, InboundMessage } from "./transport";

export class NoTeamsTransport extends Error {}

function tokenFrom(root: string): string {
  try { return channelToken(root, "teams"); }
  catch (e) { if (e instanceof NoChannelCredential) throw new NoTeamsTransport(e.message); throw e; }
}
function abortMs(): number { const n=Number(process.env.WHEELHOUSE_TEAMS_FETCH_ABORT_MS || "10000"); return Number.isFinite(n) && n > 0 ? n : 10000; }
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (e: any) { if (e?.name === "AbortError") throw new Error(`${label} timed out after ${timeoutMs}ms`); throw e; }
  finally { clearTimeout(timer); }
}
function htmlText(s: string): string { return s.replace(/<[^>]+>/g, "").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"); }

export class TeamsTransport implements ChannelTransport {
  kind = "teams" as const;
  root: string;
  apiBase: string;
  constructor(root: string) { this.root = root; this.apiBase = (process.env.WHEELHOUSE_TEAMS_API_BASE || "https://graph.microsoft.com/v1.0").replace(/\/$/, ""); }
  url(destination: string, suffix = ""): string { return `${this.apiBase}/${destination.replace(/^\/+|\/+$/g, "")}${suffix}`; }
  private parentRef(ref: string): string { return ref.replace(/\/replies\/[^/]+$/, ""); }
  private readBackSuffix(ref: string): string {
    const m = ref.match(/^(.+)\/replies\/([^/]+)$/);
    if (m) return `/messages/${encodeURIComponent(m[1])}/replies/${encodeURIComponent(m[2])}`;
    return `/messages/${encodeURIComponent(ref)}`;
  }
  async call(method: string, url: string, body?: any): Promise<any> {
    const token = tokenFrom(this.root);
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetchWithTimeout(url, init, abortMs(), `teams ${method} ${url}`);
    const json:any = await res.json().catch(()=>({ error:{ message:`HTTP ${res.status}` }}));
    if (!res.ok) throw new Error(json?.error?.message || `teams ${method} failed`);
    return json;
  }
  async post(destination: string, text: string, opts: { threadRef?: string } = {}): Promise<{ ref: string; readBack: "fetched" }> {
    const parent = opts.threadRef ? this.parentRef(opts.threadRef) : "";
    const suffix = parent ? `/messages/${encodeURIComponent(parent)}/replies` : "/messages";
    const json = await this.call("POST", this.url(destination, suffix), { body: { contentType: "text", content: text } });
    const id = String(json.id || "");
    if (!id) throw new Error("teams post returned no message id");
    const ref = parent ? `${parent}/replies/${id}` : id;
    return { ref, readBack: "fetched" };
  }
  async readBack(destination: string, ref: string, text: string): Promise<boolean> {
    try {
      const json = await this.call("GET", this.url(destination, this.readBackSuffix(ref)));
      return htmlText(String(json?.body?.content ?? "")) === text;
    } catch { return false; }
  }
  async read(destination: string, cursor?: string): Promise<{ messages: InboundMessage[]; cursor: string }> {
    const json = await this.call("GET", this.url(destination, "/messages?$top=50"));
    const messages: InboundMessage[] = [];
    let next = cursor || "";
    for (const m of json.value || []) {
      const at = String(m.createdDateTime || "");
      if (cursor && at <= cursor) continue;
      if (m.messageType && m.messageType !== "message") continue;
      if (at > next) next = at;
      messages.push({ ref: String(m.id), from: String(m.from?.user?.id ?? ""), fromName: m.from?.user?.displayName, text: htmlText(String(m.body?.content ?? "")), at, threadRef: m.replyToId ? String(m.replyToId) : undefined });
    }
    return { messages, cursor: next };
  }
}
