// Owned, inert Node ESM peer. Only the private authenticated controller can
// release replies, close stdin or exit; no provider/account access occurs.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";

const account = process.env.PI_CODING_AGENT_DIR;
const sessionFile = path.join(account, "session.jsonl");
fs.appendFileSync(sessionFile, '{"type":"fixture-session"}\n');
const socket = net.connect(process.env.WHEELHOUSE_RPC_FIXTURE_SOCKET);
const send = message => socket.write(JSON.stringify(message) + "\n");
const out = message => process.stdout.write(JSON.stringify(message) + "\n");
const input = readline.createInterface({ input: process.stdin });
let buffer = "", hold = process.env.WHEELHOUSE_RPC_FIXTURE_START_HELD === '1', pauseAfterState = false;
let pending = [], holdPrompt = false;
socket.on("connect", () => send({
  type: "ready", token: process.env.WHEELHOUSE_RPC_FIXTURE_TOKEN,
  pid: process.pid, ppid: process.ppid, uid: process.getuid(), cwd: process.cwd(),
}));
socket.on("data", data => {
  buffer += data;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    switch (message.type) {
      case "hold": hold = true; send({ type: "holding" }); break;
      case 'hold-prompt': holdPrompt = true; send({type:'holding'}); break;
      case "release":
        hold = false;
        for (const reply of pending) out(reply);
        pending = [];
        send({ type: "released" });
        break;
      case "pause-after-state": pauseAfterState = true; send({ type: "pause-armed" }); break;
      case "resume-input": input.resume(); send({ type: "input-resumed" }); break;
      case "close-input":
        input.pause(); input.close(); fs.closeSync(0);
        send({ type: "pipe-closed" });
        break;
      case "burn": {
        const until = performance.now() + 80;
        while (performance.now() < until) Math.sqrt(Math.random());
        send({ type: 'burned' }); break;
      }
      case "exit": process.exit(0);
    }
  }
});
process.on("SIGTERM", () => send({ type: "term", pid: process.pid }));
for (const signal of ['SIGINT','SIGHUP']) process.on(signal, () => send({type:'signal',signal,pid:process.pid}));
input.on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    const reply = { type: "response", id: command.id, success: true,
      data: { sessionId: "fixture-session", sessionFile, isStreaming: false } };
    if (hold) {
      pending.push(reply);
      send({ type: "held", id: command.id });
    } else out(reply);
    if (pauseAfterState) {
      pauseAfterState = false;
      input.pause();
      send({ type: "input-paused" });
    }
  } else if (command.type === "prompt") {
    const reply = {type:'response',id:command.id,success:true};
    if(holdPrompt){pending.push(reply);send({type:'held',id:command.id});}else out(reply);
    out({ type: "agent_end" });
  }
});
