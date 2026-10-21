// Display-only activity. Do not use this as the staffing/idle-alert detector:
// those consumers retain seat-activity.ts / fleet-snapshot.ts semantics.
import fs from 'node:fs';
import {agentSettledEvent} from './seat-activity';

export type SeatTurnDisplay = 'RUNNING' | 'SETTLED' | 'STALLED';
const WORK_EVENTS = new Set([
  'agent_start', 'turn_start', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'thinking', 'text', 'text_delta', 'toolcall_delta',
]);

/** Most recent observed turn boundary/work, ignoring transport responses and
 * other metadata. A missing/unparseable tail cannot prove settlement, so keep
 * the old live-process RUNNING fallback rather than infer idle from its age. */
export function seatTurnDisplay(log: string): SeatTurnDisplay {
  let fd: number | undefined;
  try {
    fd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return 'RUNNING';
    const start = Math.max(0, stat.size - 1024 * 1024), bytes = Buffer.alloc(stat.size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // A cut first record is not an observed event.
    for (let i = lines.length - 1; i >= 0; i--) {
      let event: any;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      if (agentSettledEvent(event?.type)) return event.type === 'agent_settled' && event.state === 'stalled' ? 'STALLED' : 'SETTLED';
      if (WORK_EVENTS.has(event?.type)) return 'RUNNING';
    }
  } catch { /* Live process with no readable activity evidence. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return 'RUNNING';
}
