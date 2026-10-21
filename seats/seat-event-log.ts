// Pi's persistent log bounds tool-update payloads, but keeps evidence that
// the model stream is still moving. Activity rows require actual input bytes;
// no timer manufactures a heartbeat for a dead stream.
import { StringDecoder } from "node:string_decoder";
export function eventLogFilter(write: (line: string) => void, now = Date.now, limit = Number(process.env.WHEELHOUSE_LOG_EVENT_STRING_BYTES || 65536)) {
  let lastDelta = -Infinity;
  function trim(v: any): any {
    if (typeof v === "string" && Buffer.byteLength(v) > limit) {
      const b = Buffer.from(v);
      return b.subarray(0, limit).toString("utf8") + `\n[wheelhouse log truncated ${b.length - limit} bytes; full output remains in the pi session file]`;
    }
    if (Array.isArray(v)) return v.map(trim);
    if (v && typeof v === "object") for (const key of Object.keys(v)) v[key] = trim(v[key]);
    return v;
  }
  return (line: string) => {
    try {
      let obj = JSON.parse(line);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) { write(line + "\n"); return; }
      const at = now(), ev = obj.assistantMessageEvent ?? obj.delta ?? obj;
      if (obj.type === "message_update" && /_delta$/.test(String(ev?.type ?? ""))) {
        if (at - lastDelta >= 1000) {
          write(JSON.stringify({ type: "stream_activity", sourceType: "message_update", wheelhouse_received_at: new Date(at).toISOString() }) + "\n");
          lastDelta = at;
        }
        return;
      }
      if (obj.type === "tool_execution_update") {
        const before = Buffer.byteLength(line); obj = trim(obj);
        const after = Buffer.byteLength(JSON.stringify(obj));
        if (after < before) obj.wheelhouse_truncated_bytes = before - after;
      }
      obj.wheelhouse_received_at = new Date(at).toISOString();
      write(JSON.stringify(obj) + "\n");
    } catch { write(line + "\n"); }
  };
}
if (import.meta.main) {
  const decoder = new StringDecoder("utf8"), filter = eventLogFilter(line => process.stdout.write(line));
  let pending = "";
  process.stdin.on("data", chunk => {
    pending += decoder.write(chunk);
    let i: number;
    while ((i = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, i).replace(/\r$/, ""); pending = pending.slice(i + 1); filter(line); }
  });
  process.stdin.on("end", () => { pending += decoder.end(); if (pending) filter(pending.replace(/\r$/, "")); });
}
