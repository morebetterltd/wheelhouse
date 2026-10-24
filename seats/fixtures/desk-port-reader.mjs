// Separate native reader: never forgive a visible malformed/partial record.
import fs from 'node:fs';
import readline from 'node:readline';
const file = process.argv[2];
let reads = 0, missing = 0, valid = 0, last = null, stopped = false, immediate;
function sample() {
  reads++;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') { missing++; return; } throw error; }
  try {
    const text = raw.trim(), url = new URL(text);
    if (!raw.endsWith('\n') || !text.startsWith('http://') || url.protocol !== 'http:' || url.pathname !== '/needs' || url.username || url.password || url.search || url.hash || raw !== text + '\n') throw Error('not a complete desk record');
  } catch {
    console.error('FAIL DESK_PORT_PARTIAL ' + JSON.stringify({ file, raw, reads, missing, valid }));
    process.exit(1);
  }
  valid++; last = raw;
}
function poll() {
  if (stopped) return;
  try { sample(); } catch (error) { console.error('INCOMPLETE DESK_PORT_READ ' + String(error.stack || error)); process.exit(2); }
  immediate = setImmediate(poll);
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'stop') { stopped = true; clearImmediate(immediate); console.log(JSON.stringify({ id: command.id, reads, missing, valid, last, stopped })); input.close(); process.exit(0); }
  sample(); console.log(JSON.stringify({ id: command.id, reads, missing, valid, last }));
});
input.on('close', () => { stopped = true; clearImmediate(immediate); });
poll();
