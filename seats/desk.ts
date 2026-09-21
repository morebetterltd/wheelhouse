#!/usr/bin/env bun
/** desk.ts — local human-needs desk. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fold, answerNeed, addMessage, type NeedFold } from "./needs";

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
const BD_TIMEOUT_MS = Number(process.env.WHEELHOUSE_DESK_BD_TIMEOUT_MS || "5000");
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

function fnv1a(s: string): number { let h = 0x811c9dc5; for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function namespace(): string { try { const m = fs.readFileSync(TEMPLATE_SOURCE,"utf8").match(/^namespace=(.+)$/m); if (m?.[1]?.trim()) return m[1].trim(); } catch {} return path.basename(ROOT); }
function bindHost(): string { return process.env.WHEELHOUSE_DESK_BIND || "127.0.0.1"; }
function port(): number { const raw = process.env.WHEELHOUSE_DESK_PORT; if (raw) return Number(raw); return 42000 + (fnv1a(namespace()) % 1000); }
function url(): string { return `http://${bindHost()}:${port()}/needs`; }
function esc(s: unknown): string { return String(s ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"} as any)[c]); }
function niceFrom(from: string): string { return from === "human" ? "Human" : "Fleet"; }
function needsSorted(): NeedFold[] { return Array.from(fold().values()).sort((a,b)=> (a.state==="open"?0:1)-(b.state==="open"?0:1) || b.opened.at.localeCompare(a.opened.at)); }
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
  for(const i of await bdList(["--label","needs-review"])) if(i?.id && !isDependencyBlocked(i)) add(2, boardCard(i,"in-review",verdictBounce(i.id) ? "sent back" : (seatFor(i.id,["reviewer","verifier"]) || "waiting for a reviewer"),i.started_at || i.created_at),i.id);
  for(const i of await bdList(["--status","in_progress"])) if(i?.id && !isDependencyBlocked(i)) add(1, boardCard(i,"in-progress",seatFor(i.id,["worker"]) || i.assignee || "in progress",i.started_at || i.created_at),i.id);
  for(const id of ready){ const i=all.get(id); if(i && !isDependencyBlocked(i)) add(0, boardCard(i,"ready","ready",i.created_at),id); }
  for(const i of await bdList(["--status","closed"])) if(i?.id && recentlyClosed(i) && !isDependencyBlocked(i)) add(4, boardCard(i,"merged-recently",i.assignee || "merged",i.closed_at),i.id);
  return { generatedAt:new Date().toISOString(), columns: cols };
}
async function refreshBoard(){ if(boardRefreshing) return; boardRefreshing=true; try { boardSnapshot = await buildBoard(); } catch {} finally { boardRefreshing=false; } }
function boardPage(): string { const b=boardSnapshot; const col=(c:BoardColumn)=>`<section class="board-column" data-column="${esc(c.id)}"><h2>${esc(c.title)}</h2>${c.cards.map(card=>`<article class="board-card" data-key="${esc(card.key)}"><h3>${esc(card.title)}</h3><p><span class="priority">${esc(card.priority)}</span> <span class="age">${esc(card.age)}</span> <span class="seat">${esc(card.seat)}</span>${card.needHref?` <a href="${esc(card.needHref)}">Open need</a>`:""}</p></article>`).join("") || "<p>No work here.</p>"}</section>`; return `<!doctype html><meta charset="utf-8"><title>Wheelhouse board</title><style>body{font-family:system-ui;margin:2rem}.board{display:grid;grid-template-columns:repeat(5,minmax(12rem,1fr));gap:1rem}.board-column{border:1px solid #ddd;border-radius:10px;padding:1rem}.board-card{border:1px solid #ccc;border-radius:8px;padding:.75rem;margin:.75rem 0}.priority{font-weight:700}.seat{display:block;color:#555}</style><h1>Wheelhouse board</h1><p>Read-only work view for the human. It refreshes every 5 seconds.</p><main class="board">${b.columns.map(col).join("")}</main><script>setInterval(()=>fetch('/api/board.json').then(r=>r.ok&&r.json()).catch(()=>{}),5000)</script>`; }
function thread(n: NeedFold): string { const rows:any[]=[...n.messages]; if(n.answer) rows.push(n.answer); rows.sort((a,b)=>a.at.localeCompare(b.at)); return rows.map(e=>`<li><strong>${esc(niceFrom(e.from))}</strong> <time>${esc(e.at)}</time><p>${esc(e.text)}</p></li>`).join(""); }
function card(n: NeedFold): string {
  const open = n.state === "open";
  const opts = n.opened.options.map(o=>`<button name="choice" value="${esc(o.label)}">${esc(o.label)}: ${esc(o.text)}</button>`).join(" ");
  return `<article class="need ${esc(n.state)}"><h2>${esc(n.opened.title)}</h2><p>${esc(n.opened.body)}</p>${n.opened.default?`<p><b>Default:</b> ${esc(n.opened.default)}</p>`:""}${n.opened.consequence?`<p><b>Consequence:</b> ${esc(n.opened.consequence)}</p>`:""}${n.opened.options.length?`<form method="post" action="/api/needs/${encodeURIComponent(n.id)}/answer"><input type="hidden" name="text" value=""><div class="options">${opts}</div></form>`:""}${open?`<form method="post" action="/api/needs/${encodeURIComponent(n.id)}/answer"><label>Reply <textarea name="text" required></textarea></label><button>Send answer</button></form><form method="post" action="/api/needs/${encodeURIComponent(n.id)}/message"><label>Message <textarea name="text" required></textarea></label><button>Send message</button></form>`:`<p class="history-state">${esc(n.state)}</p>`}<ol class="thread">${thread(n)}</ol></article>`;
}
function page(): string { const all=needsSorted(); const open=all.filter(n=>n.state==="open"); const hist=all.filter(n=>n.state!=="open"); return `<!doctype html><meta charset="utf-8"><title>Wheelhouse desk</title><style>body{font-family:system-ui;margin:2rem;max-width:70rem}article{border:1px solid #ccc;border-radius:10px;padding:1rem;margin:1rem 0}.answered,.closed{opacity:.75}textarea{display:block;width:100%;min-height:5rem}button{margin:.25rem}.thread{background:#f7f7f7;padding:1rem 1rem 1rem 2rem}</style><h1>Wheelhouse desk</h1><p>Open requests first. This page is local to this install.</p><section><h2>Open</h2>${open.map(card).join("") || "<p>No open requests.</p>"}</section><section><h2>History</h2>${hist.map(card).join("") || "<p>No history.</p>"}</section><script>setInterval(()=>fetch('/api/needs.json').then(r=>r.ok&&r.json()).catch(()=>{}),5000)</script>`; }
async function form(req: Request): Promise<URLSearchParams> { const ct=req.headers.get("content-type")||""; if(ct.includes("application/json")){ const j:any=await req.json(); return new URLSearchParams(Object.entries(j).map(([k,v])=>[k,String(v)])); } return new URLSearchParams(await req.text()); }
function redirect(){ return new Response("",{status:303,headers:{location:"/needs"}}); }
function status(){ const pid = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE,"utf8").trim() : ""; if(!pid) console.log("desk STOPPED — no pid file"); else { try { process.kill(Number(pid),0); console.log(`desk RUNNING pid ${pid} — ${fs.existsSync(PORT_FILE)?fs.readFileSync(PORT_FILE,"utf8").trim():url()}`); } catch { console.log(`desk DEAD pid ${pid || "?"}`); } } }
async function handle(req: Request): Promise<Response> { const u=new URL(req.url); if(req.method==="GET" && u.pathname==="/") return Response.redirect("/needs",302); if(req.method==="GET" && u.pathname==="/needs") return new Response(page(),{headers:{"content-type":"text/html; charset=utf-8"}}); if(req.method==="GET" && u.pathname==="/board") return new Response(boardPage(),{headers:{"content-type":"text/html; charset=utf-8"}}); if(req.method==="GET" && u.pathname==="/api/needs.json") return Response.json(needsSorted().map(publicNeed)); if(req.method==="GET" && u.pathname==="/api/board.json") return Response.json(boardSnapshot); if(u.pathname==="/board" || u.pathname==="/api/board.json") return new Response("not found",{status:404}); const m=u.pathname.match(/^\/api\/needs\/([^/]+)\/(answer|message)$/); if(req.method==="POST" && m){ const id=decodeURIComponent(m[1]); const body=await form(req); const text=(body.get("text")||body.get("choice")||"").trim(); const choice=body.get("choice")||undefined; if(!text) return new Response("text required",{status:400}); if(m[2]==="answer") answerNeed(id,text,"desk",choice); else addMessage(id,text,"human","desk"); return redirect(); } return new Response("not found",{status:404}); }
function start(){ fs.mkdirSync(RUN,{recursive:true}); const host=bindHost(), p=port(); const server=Bun.serve({hostname:host, port:p, idleTimeout:DESK_IDLE_TIMEOUT, fetch:handle}); fs.writeFileSync(PORT_FILE, `http://${host}:${server.port}/needs\n`); console.log(`desk started: http://${host}:${server.port}/needs`); refreshBoard(); setInterval(refreshBoard, BOARD_REFRESH_MS); }
const args=process.argv.slice(2); if(args.includes("--status")) status(); else start();
