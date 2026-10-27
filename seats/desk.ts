#!/usr/bin/env bun
/** desk.ts — local human-needs desk. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fold, answerNeed, addMessage, type NeedFold } from "./needs";
import type { Digest } from "./digest";

const ROOT = path.resolve(process.env.WHEELHOUSE_NEEDS_ROOT || process.env.WHEELHOUSE_DESK_ROOT || path.join(import.meta.dir, ".."));
const SEATS = path.join(ROOT, "seats");
const RUN = path.join(SEATS, "run");
const TEMPLATE_SOURCE = path.join(ROOT, "wheelhouse", ".template-source");
const PID_FILE = path.join(RUN, "desk.pid");
const PORT_FILE = path.join(RUN, "desk.port");
const STATE = path.join(SEATS, "state.json");
const VERDICTS = path.join(SEATS, "verdicts");
const BOARD_CACHE_MS = 15_000;
const BOARD_REFRESH_MS = Number(process.env.WHEELHOUSE_DESK_BOARD_REFRESH_MS || "5000");
const DIGEST_REFRESH_MS = Number(process.env.WHEELHOUSE_DESK_DIGEST_REFRESH_MS || "60000");
const BD_TIMEOUT_MS = Number(process.env.WHEELHOUSE_DESK_BD_TIMEOUT_MS || "5000");
const DIGEST_TIMEOUT_MS = Number(process.env.WHEELHOUSE_DESK_DIGEST_TIMEOUT_MS || String(BD_TIMEOUT_MS * 4));
const DESK_IDLE_TIMEOUT = Number(process.env.WHEELHOUSE_DESK_IDLE_TIMEOUT || "255");

type Issue = { id:string; title:string; status?:string; priority?:string; assignee?:string; created_at?:string; started_at?:string; closed_at?:string; labels?:string[]; [key:string]:any };
type BoardCard = { key:string; title:string; priority:string; age:string; seat:string; needHref?:string };
type BoardColumn = { id:string; title:string; cards:BoardCard[] };
type Board = { generatedAt:string; columns:BoardColumn[] };
type CacheEntry<T> = { at:number; value:T };
const bdCache = new Map<string, CacheEntry<any>>();
const emptyBoard = (): Board => ({ generatedAt:new Date(0).toISOString(), columns:[
  { id:"ready", title:"Ready", cards:[] },
  { id:"in-progress", title:"In progress", cards:[] },
  { id:"in-review", title:"In review", cards:[] },
  { id:"blocked-on-you", title:"Blocked on you", cards:[] },
  { id:"merged-recently", title:"Merged recently", cards:[] },
] });
let boardSnapshot: Board = emptyBoard();
let boardRefreshing = false;
let digestSnapshot: Digest = emptyDigest();
const RAW_DIGEST_CACHE_MAX = Number(process.env.WHEELHOUSE_DESK_DIGEST_CACHE_MAX || "16");
const DIGEST_CACHE_MAX = Number.isFinite(RAW_DIGEST_CACHE_MAX) ? Math.max(1, Math.floor(RAW_DIGEST_CACHE_MAX)) : 16;
const digestCache = new Map<string, CacheEntry<Digest>>();
const digestRefreshing = new Set<string>();
const DIGEST_REFRESH_MAX = 2;

function fnv1a(s: string): number { let h = 0x811c9dc5; for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function namespace(): string { try { const m = fs.readFileSync(TEMPLATE_SOURCE,"utf8").match(/^namespace=(.+)$/m); if (m?.[1]?.trim()) return m[1].trim(); } catch {} return path.basename(ROOT); }
function emptyDigest(win?: { since: string; until: string }): Digest { const until=win ? new Date(win.until) : new Date(0), since=win ? new Date(win.since) : new Date(until.getTime()-24*3600000); return { window:{since:since.toISOString(), until:until.toISOString()}, namespace:namespace(), seats:[], shipped:[], blocked:[], cleared:[], inReview:[], sentBack:[], failed:{summary:{events:0,stillFailing:0},items:[]}, alerts:[] }; }
function bindHost(): string { return process.env.WHEELHOUSE_DESK_BIND || "127.0.0.1"; }
function port(): number { const raw = process.env.WHEELHOUSE_DESK_PORT; if (raw) return Number(raw); return 42000 + (fnv1a(namespace()) % 1000); }
function url(): string { return `http://${bindHost()}:${port()}/needs`; }
function esc(s: unknown): string { return String(s ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"} as any)[c]); }
function niceFrom(from: string): string { return from === "human" ? "Human" : "Fleet"; }
function needRank(n: NeedFold): number { return n.state === "open" ? 0 : n.state === "answered" ? 1 : 2; }
function needsSorted(): NeedFold[] { return Array.from(fold().values()).sort((a,b)=> needRank(a)-needRank(b) || b.opened.at.localeCompare(a.opened.at)); }
function publicNeed(n: NeedFold){ return { id:n.id, state:n.state, kind:n.opened.kind, title:n.opened.title, body:n.opened.body, options:n.opened.options, default:n.opened.default, consequence:n.opened.consequence, messages:n.messages, answer:n.answer, closed:n.closed, openedAt:n.opened.at }; }
async function runCached(cmd: string[]): Promise<string> {
  const key = cmd.join("\0"), now = Date.now(), hit = bdCache.get(key);
  if (hit && now - hit.at < BOARD_CACHE_MS) return hit.value;
  let out = "";
  try {
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const killed = setTimeout(() => { try { proc.kill(); } catch {} }, BD_TIMEOUT_MS);
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited.catch(()=>1)]);
    clearTimeout(killed);
    out = code === 0 ? text : "";
  } catch { out = ""; }
  bdCache.set(key, { at: Date.now(), value: out });
  return out;
}
function parseIssueList(out: string): Issue[] { try { const j=JSON.parse(out||"[]"); return Array.isArray(j) ? j : (Array.isArray(j?.issues) ? j.issues : []); } catch { return []; } }
async function bdList(args: string[]): Promise<Issue[]> { return parseIssueList(await runCached(["bd", "list", "--json", "--limit", "0", ...args])); }
async function readyIds(): Promise<Set<string>> { return new Set((await runCached(["bd", "ready"])).split(/\r?\n/).map(l=>l.trim().split(/\s+/)[0]).filter(Boolean)); }
async function issueMap(): Promise<Map<string, Issue>> { const m=new Map<string,Issue>(); for(const row of await bdList([])) if(row?.id) m.set(row.id,row); return m; }
function isDependencyBlocked(i: Issue): boolean { return i.status === "blocked" || i.blocked === true || Number(i.blocked_by_count ?? i.blocked_count ?? 0) > 0 || (Array.isArray(i.blocked_by) && i.blocked_by.length > 0); }
function normPriority(p: unknown): string { const m=String(p ?? "P3").match(/P?[0-3]/i); return m ? `P${m[0].replace(/^P/i,"")}` : "P3"; }
function ageSince(raw?: string): string { const t=raw ? Date.parse(raw) : NaN; if(!Number.isFinite(t)) return "unknown age"; const ms=Math.max(0, Date.now()-t), h=Math.floor(ms/36e5), d=Math.floor(h/24); if(d>0) return `${d}d`; if(h>0) return `${h}h`; return `${Math.max(1,Math.floor(ms/6e4))}m`; }
function cardKey(id: string, column: string): string { return `c-${fnv1a(`${column}:${id}`).toString(36)}`; }
function stateRows(): Record<string, any> { try { const j=JSON.parse(fs.readFileSync(STATE,"utf8")); return j.seats ?? j; } catch { return {}; } }
function seatFor(bead: string, roles: string[]): string | null { for(const [name,row] of Object.entries(stateRows())){ const r:any=row; if(r?.lastBead===bead && roles.includes(String(r.role||""))) return name; } return null; }
function verdictBounce(bead: string): boolean { try { return /(^|\n)\s*(?:VERDICT\s*:\s*)?BOUNCE\b/i.test(fs.readFileSync(path.join(VERDICTS, `${bead}.md`), "utf8")); } catch { return false; } }
function recentlyClosed(i: Issue): boolean { const t=Date.parse(String(i.closed_at||"")); return Number.isFinite(t) && Date.now()-t <= 48*36e5; }
function openNeedByBead(): Map<string, NeedFold> { const m=new Map<string,NeedFold>(); for(const n of fold().values()) if(n.state==="open" && n.opened.machine?.bead) m.set(n.opened.machine.bead, n); return m; }
function boardCard(i: Issue, column: string, seat: string, rawAge?: string, needHref?: string): BoardCard { return { key:cardKey(i.id,column), title:String(i.title||"Untitled work"), priority:normPriority(i.priority), age:ageSince(rawAge), seat, needHref }; }
async function buildBoard(): Promise<Board> {
  const all=await issueMap(), ready=await readyIds(), openNeeds=openNeedByBead();
  const cols: BoardColumn[] = [
    { id:"ready", title:"Ready", cards:[] },
    { id:"in-progress", title:"In progress", cards:[] },
    { id:"in-review", title:"In review", cards:[] },
    { id:"blocked-on-you", title:"Blocked on you", cards:[] },
    { id:"merged-recently", title:"Merged recently", cards:[] },
  ];
  const placed = new Set<string>();
  const add=(idx:number, c:BoardCard, id:string)=>{ if(placed.has(id)) return; cols[idx].cards.push(c); placed.add(id); };
  for(const [id,n] of openNeeds){ const i=all.get(id); if(i && !isDependencyBlocked(i)) add(3, boardCard(i,"blocked-on-you","waiting on you",n.opened.at,"/needs"),id); }
  for(const i of await bdList(["--label","needs-review"])) if(i?.id && !isDependencyBlocked(i)) add(2, boardCard(i,"in-review",verdictBounce(i.id) ? "sent back" : (seatFor(i.id,["reviewer"]) || "waiting for a reviewer"),i.started_at || i.created_at),i.id);
  for(const i of await bdList(["--status","in_progress"])) if(i?.id && !isDependencyBlocked(i)) add(1, boardCard(i,"in-progress",seatFor(i.id,["worker"]) || i.assignee || "in progress",i.started_at || i.created_at),i.id);
  for(const id of ready){ const i=all.get(id); if(i && !isDependencyBlocked(i)) add(0, boardCard(i,"ready","ready",i.created_at),id); }
  for(const i of await bdList(["--status","closed"])) if(i?.id && recentlyClosed(i) && !isDependencyBlocked(i)) add(4, boardCard(i,"merged-recently",i.assignee || "merged",i.closed_at),i.id);
  return { generatedAt:new Date().toISOString(), columns: cols };
}
async function refreshBoard(){ if(boardRefreshing) return; boardRefreshing=true; try { boardSnapshot = await buildBoard(); } catch {} finally { boardRefreshing=false; } }
class BadDigestWindow extends Error {}
type DigestWindow = { since: string; until: string; key: string; label: string; isDefault: boolean };
function digestWindow(u?: URL): DigestWindow {
  const params = u?.searchParams;
  const rawUntil = params?.get("until");
  const rawSince = params?.get("since");
  const hasHours = !!params?.has("hours");
  const rawHours = params?.get("hours") || "24";
  const until = rawUntil ? new Date(rawUntil) : new Date();
  const hours = Number(rawHours);
  if (!Number.isFinite(hours) || hours <= 0) throw new BadDigestWindow("invalid digest window");
  const since = rawSince ? new Date(rawSince) : new Date(until.getTime() - hours * 3600000);
  try { since.toISOString(); until.toISOString(); } catch { throw new BadDigestWindow("invalid digest window"); }
  const win = { since: since.toISOString(), until: until.toISOString() };
  const key = rawSince || rawUntil ? `${win.since}\0${win.until}` : `hours:${hours}`;
  return { ...win, key, label: rawSince || rawUntil || hasHours ? `${win.since} → ${win.until}` : "last 24 h", isDefault: !(rawSince || rawUntil || hasHours) };
}
function digestCacheGet(key: string): Digest | undefined { const hit=digestCache.get(key); if(!hit) return undefined; digestCache.delete(key); digestCache.set(key, hit); return hit.value; }
function digestCacheSet(key: string, value: Digest){ digestCache.set(key, { at: Date.now(), value }); while(digestCache.size > DIGEST_CACHE_MAX){ const oldest=digestCache.keys().next().value; if(oldest === undefined) break; digestCache.delete(oldest); } }
function digestCacheFresh(key: string): boolean { const hit=digestCache.get(key); return !!hit && Date.now()-hit.at < DIGEST_REFRESH_MS; }
function scheduleDigestRefresh(win = digestWindow()){
  if(digestRefreshing.has(win.key) || digestCacheFresh(win.key) || digestRefreshing.size >= DIGEST_REFRESH_MAX) return;
  digestRefreshing.add(win.key);
  setTimeout(() => {
    (async () => {
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let completed = false;
      const stopChild = () => {
        if(!child || completed) return;
        // detached gives this job its own group; a timed-out native bd query
        // must not outlive the digest process and accumulate orphan queries.
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      };
      try {
        // Bun 1.2.22 on Darwin retained allocations when Worker VMs were recreated,
        // even after termination/revocation. Native process exit ends that
        // allocation lifetime; use the existing read-only JSON CLI unchanged.
        child = Bun.spawn({cmd:[process.execPath,path.join(SEATS,"digest.ts"),"--json","--since",win.since,"--until",win.until],cwd:ROOT,
          env:{...process.env,WHEELHOUSE_DIGEST_ROOT:ROOT,WHEELHOUSE_NEEDS_ROOT:ROOT},
          stdin:"ignore",stdout:"pipe",stderr:"ignore",detached:true});
        deadline = setTimeout(stopChild, DIGEST_TIMEOUT_MS);
        const [text, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(),child.exited.then(code => { completed = true; return code; })]);
        if(code !== 0) return;
        const next = JSON.parse(text) as Digest;
        if(next?.window?.since !== win.since || next?.window?.until !== win.until ||
          !["seats","shipped","blocked","cleared","inReview","sentBack","alerts"].every(key => Array.isArray((next as any)[key])) ||
          !next.failed?.summary || !Array.isArray(next.failed.items)) return;
        digestCacheSet(win.key, next);
        if(win.isDefault) digestSnapshot = next;
      } catch {} finally {
        if(deadline) clearTimeout(deadline);
        if(child && !completed) { stopChild(); await child.exited.catch(() => {}); }
        digestRefreshing.delete(win.key);
      }
    })();
  }, 0).unref?.();
}
function digestFor(u?: URL): { status: number; digest?: Digest; heading?: string; error?: string } {
  let win: DigestWindow;
  try { win = digestWindow(u); } catch { return { status:400, error:"invalid digest window" }; }
  scheduleDigestRefresh(win);
  if(win.isDefault) return { status:200, digest:digestSnapshot, heading:`Digest: ${win.label}` };
  return { status:200, digest:digestCacheGet(win.key) || emptyDigest(win), heading:`Digest: ${win.label}` };
}
function localTime(at:any): string { const d=new Date(String(at||"")); if(!Number.isFinite(d.getTime())) return "unknown time"; return d.toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",timeZoneName:"short"}); }
function shortSha(s:any): string { return String(s||"").slice(0,7); }
function safeText(s:any): string { return String(s ?? "").replace(new RegExp(`\\b${namespace().replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}-[a-z0-9_.-]+\\b`,"ig"),"work item").replace(/\bbead\b/ig,"task"); }
function digestLink(href:string, text:string): string { return ` <a href="${esc(href)}">${esc(text)}</a>`; }
function digestLine(title:any, at:any, reason:any, links=""): string { return `<li><span class="title">${esc(safeText(title))}</span> <time>${esc(localTime(at))}</time> — <span class="reason">${esc(safeText(reason||"updated"))}</span>${links}</li>`; }
function digestPage(d: Digest, heading = "Digest: last 24 h"): string { const empty=(s:string)=>`<p>[${esc(s)}]</p>`; const section=(name:string, body:string)=>`<section><h2>${esc(name)}</h2>${body}</section>`; const shipped=d.shipped.some((x:any)=>x.unavailable)?empty("bd unavailable"):d.shipped.length?`<ul>${d.shipped.map((s:any)=>digestLine(s.title,s.at,`merged ${s.sha?shortSha(s.sha):"closed"}; verdict ${s.verdict||"unknown"}`,s.links?.commit?digestLink(s.links.commit,`commit ${shortSha(s.sha)}`):"")).join("")}</ul>`:empty("Nothing merged."); const blocked=[...d.blocked.map((n:any)=>digestLine(n.title,n.at,`${n.kind||"need"}, age ${n.ageMinutes??"?"}m`,digestLink("/needs","need"))),...d.cleared.map((n:any)=>digestLine(n.title,n.at,`${n.kind||"need"} cleared`,digestLink("/needs","need")))]; const review=d.inReview.some((x:any)=>x.unavailable)?empty("bd unavailable"):d.inReview.length?`<ul>${d.inReview.map((r:any)=>digestLine(r.title,r.deliveryAt||r.at,r.links?.verdict?"delivered for review":"delivered for review; no verdict record yet",r.links?.verdict?digestLink(`/${r.links.verdict}`,"verdict"):"")).join("")}</ul>`:empty("Nothing waiting."); const sent=d.sentBack.length?`<ul>${d.sentBack.map((r:any)=>digestLine(r.title,r.at,`BOUNCE round ${r.round}: ${r.reason}; ${r.rework}`,"")).join("")}</ul>`:empty("Nothing sent back."); const failed=d.failed.items.length?`<p>${esc(String(d.failed.summary.events))} events, ${esc(String(d.failed.summary.stillFailing))} still failing</p><ul>${d.failed.items.map((f:any)=>digestLine(f.title||f.seat||f.kind,f.at,f.first||f.recovered||f.kind,"")).join("")}</ul>`:empty("Nothing failed."); return `<!doctype html><meta charset="utf-8"><title>Wheelhouse digest</title><style>body{font-family:system-ui;margin:2rem;max-width:70rem}section{border:1px solid #ddd;border-radius:10px;padding:1rem;margin:1rem 0}li{margin:.5rem 0}time{color:#555}.title{font-weight:700}</style><h1>Wheelhouse digest</h1><p>${esc(heading)}</p><p>Seats: ${esc(d.seats.map(s=>`${s.role} ${s.provider}/${s.model}`).join(", ")||"no rostered seats")}</p>${section("Shipped",shipped)}${section("Blocked on you",blocked.length?`<ul>${blocked.join("")}</ul>`:empty("Nothing open."))}${section("In review",review)}${section("Sent back",sent)}${section("Failed and why",failed)}`; }
function boardPage(): string { const b=boardSnapshot; const col=(c:BoardColumn)=>`<section class="board-column" data-column="${esc(c.id)}"><h2>${esc(c.title)}</h2>${c.cards.map(card=>`<article class="board-card" data-key="${esc(card.key)}"><h3>${esc(card.title)}</h3><p><span class="priority">${esc(card.priority)}</span> <span class="age">${esc(card.age)}</span> <span class="seat">${esc(card.seat)}</span>${card.needHref?` <a href="${esc(card.needHref)}">Open need</a>`:""}</p></article>`).join("") || "<p>No work here.</p>"}</section>`; return `<!doctype html><meta charset="utf-8"><title>Wheelhouse board</title><style>body{font-family:system-ui;margin:2rem}.board{display:grid;grid-template-columns:repeat(5,minmax(12rem,1fr));gap:1rem}.board-column{border:1px solid #ddd;border-radius:10px;padding:1rem}.board-card{border:1px solid #ccc;border-radius:8px;padding:.75rem;margin:.75rem 0}.priority{font-weight:700}.seat{display:block;color:#555}</style><h1>Wheelhouse board</h1><p>Read-only work view for the human. It refreshes every 5 seconds.</p><p><a href="/digest">Digest: last 24 h</a></p><main class="board">${b.columns.map(col).join("")}</main><script>setInterval(()=>fetch('/api/board.json').then(r=>r.ok&&r.json()).catch(()=>{}),5000)</script>`; }
function thread(n: NeedFold): string { const rows:any[]=[...n.messages]; if(n.answer) rows.push(n.answer); rows.sort((a,b)=>a.at.localeCompare(b.at)); return rows.map(e=>`<li><strong>${esc(niceFrom(e.from))}</strong> <time>${esc(e.at)}</time><p>${esc(e.text)}</p></li>`).join(""); }
function card(n: NeedFold): string {
  const active = n.state !== "closed";
  const opts = n.opened.options.map(o=>`<button name="choice" value="${esc(o.label)}">${esc(o.label)}: ${esc(o.text)}</button>`).join(" ");
  return `<article class="need ${esc(n.state)}"><h2>${esc(n.opened.title)}</h2><p>${esc(n.opened.body)}</p>${n.opened.default?`<p><b>Default:</b> ${esc(n.opened.default)}</p>`:""}${n.opened.consequence?`<p><b>Consequence:</b> ${esc(n.opened.consequence)}</p>`:""}${active && n.opened.options.length?`<form method="post" action="/api/needs/${encodeURIComponent(n.id)}/answer"><input type="hidden" name="text" value=""><div class="options">${opts}</div></form>`:""}${active?`<form method="post" action="/api/needs/${encodeURIComponent(n.id)}/answer"><label>Reply <textarea name="text" required></textarea></label><button>Send answer</button></form><form method="post" action="/api/needs/${encodeURIComponent(n.id)}/message"><label>Message <textarea name="text" required></textarea></label><button>Send message</button></form>`:`<p class="history-state">${esc(n.state)}</p>`}<ol class="thread">${thread(n)}</ol></article>`;
}
function page(): string { const all=needsSorted(); const open=all.filter(n=>n.state!=="closed"); const hist=all.filter(n=>n.state==="closed"); return `<!doctype html><meta charset="utf-8"><title>Wheelhouse desk</title><style>body{font-family:system-ui;margin:2rem;max-width:70rem}article{border:1px solid #ccc;border-radius:10px;padding:1rem;margin:1rem 0}.answered,.closed{opacity:.75}textarea{display:block;width:100%;min-height:5rem}button{margin:.25rem}.thread{background:#f7f7f7;padding:1rem 1rem 1rem 2rem}</style><h1>Wheelhouse desk</h1><p>Open requests first. This page is local to this install.</p><p><a href="/digest">Digest: last 24 h</a></p><section><h2>Open</h2>${open.map(card).join("") || "<p>No open requests.</p>"}</section><section><h2>History</h2>${hist.map(card).join("") || "<p>No history.</p>"}</section><script>setInterval(()=>fetch('/api/needs.json').then(r=>r.ok&&r.json()).catch(()=>{}),5000)</script>`; }
async function form(req: Request): Promise<URLSearchParams> { const ct=req.headers.get("content-type")||""; if(ct.includes("application/json")){ const j:any=await req.json(); return new URLSearchParams(Object.entries(j).map(([k,v])=>[k,String(v)])); } return new URLSearchParams(await req.text()); }
function redirect(){ return new Response("",{status:303,headers:{location:"/needs"}}); }
function status(){ const pid = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE,"utf8").trim() : ""; if(!pid) console.log("desk STOPPED — no pid file"); else { try { process.kill(Number(pid),0); console.log(`desk RUNNING pid ${pid} — ${fs.existsSync(PORT_FILE)?fs.readFileSync(PORT_FILE,"utf8").trim():url()}`); } catch { console.log(`desk DEAD pid ${pid || "?"}`); } } }
async function handle(req: Request): Promise<Response> { const u=new URL(req.url); if(req.method==="GET" && u.pathname==="/") return Response.redirect("/needs",302); if(req.method==="GET" && u.pathname==="/needs") return new Response(page(),{headers:{"content-type":"text/html; charset=utf-8"}}); if(req.method==="GET" && u.pathname==="/board") return new Response(boardPage(),{headers:{"content-type":"text/html; charset=utf-8"}}); if(req.method==="GET" && u.pathname==="/digest") { const r=digestFor(u); if(r.status!==200) return new Response(r.error||"bad digest window",{status:r.status}); return new Response(digestPage(r.digest!,r.heading),{headers:{"content-type":"text/html; charset=utf-8"}}); } if(req.method==="GET" && u.pathname==="/api/needs.json") return Response.json(needsSorted().map(publicNeed)); if(req.method==="GET" && u.pathname==="/api/board.json") return Response.json(boardSnapshot); if(req.method==="GET" && u.pathname==="/api/digest.json") { const r=digestFor(u); if(r.status!==200) return new Response(r.error||"bad digest window",{status:r.status}); return Response.json(r.digest); } if(u.pathname==="/board" || u.pathname==="/api/board.json" || u.pathname==="/digest" || u.pathname==="/api/digest.json") return new Response("not found",{status:404}); const m=u.pathname.match(/^\/api\/needs\/([^/]+)\/(answer|message)$/); if(req.method==="POST" && m){ const id=decodeURIComponent(m[1]); const body=await form(req); const text=(body.get("text")||body.get("choice")||"").trim(); const choice=body.get("choice")||undefined; if(!text) return new Response("text required",{status:400}); if(m[2]==="answer") answerNeed(id,text,"desk",choice); else addMessage(id,text,"human","desk"); return redirect(); } return new Response("not found",{status:404}); }
function publishPort(value: string) {
  const temp = `${PORT_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, value, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, PORT_FILE);
  } finally { fs.rmSync(temp, { force: true }); }
}
function start(){ fs.mkdirSync(RUN,{recursive:true}); const host=bindHost(), p=port(); const server=Bun.serve({hostname:host, port:p, idleTimeout:DESK_IDLE_TIMEOUT, fetch:handle}); publishPort(`http://${host}:${server.port}/needs\n`); console.log(`desk started: http://${host}:${server.port}/needs`); console.log(`digest: http://${host}:${server.port}/digest`); refreshBoard(); scheduleDigestRefresh(); setInterval(refreshBoard, BOARD_REFRESH_MS); setInterval(()=>scheduleDigestRefresh(), DIGEST_REFRESH_MS); }
const args=process.argv.slice(2); if(args.includes("--status")) status(); else start();
