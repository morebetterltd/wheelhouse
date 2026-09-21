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

function fnv1a(s: string): number { let h = 0x811c9dc5; for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function namespace(): string { try { const m = fs.readFileSync(TEMPLATE_SOURCE,"utf8").match(/^namespace=(.+)$/m); if (m?.[1]?.trim()) return m[1].trim(); } catch {} return path.basename(ROOT); }
function bindHost(): string { return process.env.WHEELHOUSE_DESK_BIND || "127.0.0.1"; }
function port(): number { const raw = process.env.WHEELHOUSE_DESK_PORT; if (raw) return Number(raw); return 42000 + (fnv1a(namespace()) % 1000); }
function url(): string { return `http://${bindHost()}:${port()}/needs`; }
function esc(s: unknown): string { return String(s ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"} as any)[c]); }
function niceFrom(from: string): string { return from === "human" ? "Human" : "Fleet"; }
function needsSorted(): NeedFold[] { return Array.from(fold().values()).sort((a,b)=> (a.state==="open"?0:1)-(b.state==="open"?0:1) || b.opened.at.localeCompare(a.opened.at)); }
function publicNeed(n: NeedFold){ return { id:n.id, state:n.state, kind:n.opened.kind, title:n.opened.title, body:n.opened.body, options:n.opened.options, default:n.opened.default, consequence:n.opened.consequence, messages:n.messages, answer:n.answer, closed:n.closed, openedAt:n.opened.at }; }
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
async function handle(req: Request): Promise<Response> { const u=new URL(req.url); if(req.method==="GET" && u.pathname==="/") return Response.redirect("/needs",302); if(req.method==="GET" && u.pathname==="/needs") return new Response(page(),{headers:{"content-type":"text/html; charset=utf-8"}}); if(req.method==="GET" && u.pathname==="/api/needs.json") return Response.json(needsSorted().map(publicNeed)); const m=u.pathname.match(/^\/api\/needs\/([^/]+)\/(answer|message)$/); if(req.method==="POST" && m){ const id=decodeURIComponent(m[1]); const body=await form(req); const text=(body.get("text")||body.get("choice")||"").trim(); const choice=body.get("choice")||undefined; if(!text) return new Response("text required",{status:400}); if(m[2]==="answer") answerNeed(id,text,"desk",choice); else addMessage(id,text,"human","desk"); return redirect(); } return new Response("not found",{status:404}); }
function start(){ fs.mkdirSync(RUN,{recursive:true}); const host=bindHost(), p=port(); const server=Bun.serve({hostname:host, port:p, fetch:handle}); fs.writeFileSync(PORT_FILE, `http://${host}:${server.port}/needs\n`); console.log(`desk started: http://${host}:${server.port}/needs`); }
const args=process.argv.slice(2); if(args.includes("--status")) status(); else start();
