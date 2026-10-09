import * as fs from "node:fs";
import * as path from "node:path";
import { hasPool, loadPool, seatEntryFor, PoolError, type SeatEntry } from "./pool";

export interface StaffingSeat { role: "worker" | "verifier"; entry: string; addedAt?: string }
export interface StaffingFile { version: 1; seats: Record<string, StaffingSeat>; rateLimited?: Record<string, { at: string; detail: string }>; lastCheck?: any }

export function staffingPath(root: string): string { return path.join(root, "seats", "staffing.json"); }
export function fixedRoster(root: string): Record<string, SeatEntry> {
  try { return JSON.parse(fs.readFileSync(path.join(root, "seats", "seats.json"), "utf8")).seats ?? {}; } catch { return {}; }
}

function readStaffing(root: string): StaffingFile | null {
  const file = staffingPath(root);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e: any) { throw new PoolError(`STOP: seats/staffing.json: cannot read staffing record — fix: repair or remove ${file}`); }
}

function poolRoleForStaffedSeat(seatName: string, seat: StaffingSeat): "workers" | "reviewers" {
  if (seat.role === "worker") return "workers";
  if (seat.role === "verifier") return "reviewers";
  throw new PoolError(`STOP: seats/staffing.json: seat ${seatName} has invalid role ${JSON.stringify((seat as any).role)} — fix: use worker or verifier`);
}

export function effectiveRoster(root: string): Record<string, SeatEntry> {
  const seats = fixedRoster(root);
  const staffing = readStaffing(root);
  if (!hasPool(root)) {
    if (staffing && Object.keys(staffing.seats ?? {}).length > 0) throw new PoolError("STOP: seats/staffing.json: staffed seats exist but seats/pool.json is absent — fix: restore the pool or remove staffing.json");
    return seats;
  }
  const pool = loadPool(root);
  const out: Record<string, SeatEntry> = { ...seats };
  for (const [seatName, staffed] of Object.entries(staffing?.seats ?? {})) {
    const poolRole = poolRoleForStaffedSeat(seatName, staffed);
    try { out[seatName] = seatEntryFor(pool, poolRole, staffed.entry); }
    catch (e: any) {
      if (e instanceof PoolError) throw new PoolError(`STOP: seats/staffing.json: seat ${seatName} names missing pool entry ${staffed.entry} — fix: update seats/staffing.json or seats/pool.json`);
      throw e;
    }
  }
  return out;
}

export function effectiveRosterOrThrow(root: string): Record<string, SeatEntry> {
  try { return effectiveRoster(root); } catch (e: any) { if (e instanceof PoolError) throw e; throw e; }
}
