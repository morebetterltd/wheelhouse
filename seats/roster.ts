import * as fs from "node:fs";
import * as path from "node:path";
import { hasPool, loadPool, seatEntryFor, PoolError, type SeatEntry } from "./pool";

export interface StaffingSeat { role: "worker" | "reviewer"; entry: string; addedAt?: string }
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
  if (seat.role === "reviewer") return "reviewers";
  throw new PoolError(`STOP: seats/staffing.json: seat ${seatName} has invalid or legacy role ${JSON.stringify((seat as any).role)} — fix: set seats/staffing.json seats[${JSON.stringify(seatName)}].role to "reviewer" for a review seat (or "worker" for a worker); walkers belong in seats/seats.json`);
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

// Explicit install check only. Existing runtime readers keep their compatibility
// behavior; this path must not turn missing/malformed metadata into an empty pass.
export function checkProducerRoster(root: string): string | null {
  const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, "seats", file), "utf8"));
  try {
    const roster = read("seats.json");
    if (!object(roster) || !object(roster.seats)) return "seats/seats.json: seats must be an object";
    let builder = false, producer = false;
    for (const [name, seat] of Object.entries<any>(roster.seats)) {
      if (!object(seat) || typeof seat.role !== "string" || !seat.role.trim()) return `seats/seats.json: ${name}: role must be a non-empty string`;
      for (const flag of ["shadow", "external"]) if (seat[flag] !== undefined && typeof seat[flag] !== "boolean") return `seats/seats.json: ${name}: ${flag} must be boolean`;
      if (seat.role === "worker") builder = true;
      if (seat.role === "producer" && !seat.shadow) {
        if (seat.external && seat.runtime !== "commander-subagent") return `seats/seats.json: ${name}: external producer must name runtime commander-subagent`;
        producer = true;
      }
    }
    if (fs.existsSync(path.join(root, "seats", "pool.json"))) {
      const pool = read("pool.json");
      if (!object(pool) || !object(pool.roles)) return "seats/pool.json: roles must be an object";
      // Pool capacity still needs a producer even before a worker is staffed.
      if (pool.roles.workers !== undefined) builder = true;
    }
    return builder && !producer
      ? "builder seats require a non-shadow producer — fix: record a standing producer or an external commander-subagent producer under seats"
      : null;
  } catch (e: any) { return `cannot read roster metadata: ${e.message}`; }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "check" || !(args.length === 1 || (args.length === 3 && args[1] === "--root" && args[2]))) {
    console.error("usage: roster.ts check [--root <install>]");
    process.exit(3);
  }
  const root = args.length === 3 ? path.resolve(args[2]) : path.resolve(import.meta.dir, "..");
  const error = checkProducerRoster(root);
  if (error) { console.error(`STOP: ${error}`); process.exit(2); }
  console.log("roster: producer check OK");
}
