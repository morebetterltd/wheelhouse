// A dependency-free, process-local verification fixture, never an installed service.
if (process.env.BROKEN_LAUNCH === "1") {
  console.error("fixture: launch broken on purpose");
  process.exit(1);
}
const rawPort = process.env.PORT ?? "18080";
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) {
  console.error("fixture: PORT must be an integer from 0 to 65535");
  process.exit(1);
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const extras = new Set((process.env.EXTRA_FEATURES ?? "").split(",").map(s => s.trim()).filter(s => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)).map(s => "/" + s));
const page = (title: string, body: string) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><h1>${escape(title)}</h1>${body}</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
let count = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(rawPort),
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET") {
      switch (pathname) {
        case "/": return page("Five features", '<nav><a href="/">Home</a> <a href="/health">Health</a> <a href="/echo">Echo</a> <a href="/counter">Counter</a> <a href="/about">About</a></nav>');
        case "/health": return Response.json({ ok: true });
        case "/echo": return page("Echo", '<form action="/echo" method="post"><label>Text <input name="text" required></label><button>Echo</button></form>');
        case "/counter": return page("Counter", `<output id="count">${count}</output><form action="/counter/increment" method="post"><button>Increment</button></form>`);
        case "/about": return page("About", "<p>A small verification fixture with five public features.</p>");
      }
      if (extras.has(pathname)) return page(pathname.slice(1), "<p>Optional runtime feature is available.</p>");
    }
    if (request.method === "POST" && pathname === "/echo") {
      const form = await request.formData();
      return page("Echo result", `<output id="echo">${escape(String(form.get("text") ?? ""))}</output><a href="/echo">Echo again</a>`);
    }
    if (request.method === "POST" && pathname === "/counter/increment") {
      count++;
      return Response.redirect(new URL("/counter", request.url), 303);
    }
    return new Response("Not found\n", { status: 404 });
  },
});
console.log(`listening on http://127.0.0.1:${server.port}`);
