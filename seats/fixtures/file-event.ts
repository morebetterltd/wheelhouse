// The containing sweep supplies containment. A missing event is not evidence
// that a still-live actor is broken; a known actor's exit is an actual signal.
import fs from "node:fs";
const [file, text, pidText] = process.argv.slice(2);
const pid = pidText ? Number(pidText) : null;
for (;;) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(text)) break;
  if (pid) { try { process.kill(pid, 0); } catch (e) { throw new Error(`process ${pid} exited before event ${text}`, { cause: e }); } }
  await Bun.sleep(50);
}
