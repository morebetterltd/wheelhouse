import * as fs from "node:fs";
import * as path from "node:path";

// Shared roster identity lookup for outbound authority checks. Keep comms'
// default (all roster actors) while needs exempts the commander role.
export function rosterSeatActors(root: string, { excludeCommander = false } = {}): Set<string> {
  const out = new Set<string>();
  const file = path.join(root, "seats", "seats.json");
  if (!fs.existsSync(file)) return out;
  let parsed: any;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e: any) {
    process.stderr.write(`STOP: cannot parse seats/seats.json: ${e.message}\n`);
    process.exit(2);
  }
  const seats = parsed?.seats && typeof parsed.seats === "object" ? parsed.seats : {};
  for (const name of Object.keys(seats)) {
    if (excludeCommander && seats[name]?.role === "commander") continue;
    out.add(name);
    const env = `WHEELHOUSE_BEADS_ACTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const override = process.env[env];
    if (override) out.add(override);
  }
  return out;
}
