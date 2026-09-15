export const HARNESS_VALUES = ["pi", "claude-code", "codex"] as const;
export type HarnessName = (typeof HARNESS_VALUES)[number];

export function harnessNameForSeat(seatName: string, entry: { harness?: string } | undefined): HarnessName {
  const raw = entry?.harness ?? "pi";
  if ((HARNESS_VALUES as readonly string[]).includes(raw)) return raw as HarnessName;
  throw new Error(
    `seat "${seatName}" has invalid harness ${JSON.stringify(raw)} in seats/seats.json — ` +
      `must be one of ${HARNESS_VALUES.join(", ")} (or omitted for pi)`
  );
}

export function requirePiHarness(seatName: string, entry: { harness?: string } | undefined, operation: string): void {
  const harness = harnessNameForSeat(seatName, entry);
  if (harness !== "pi") {
    throw new Error(`seat "${seatName}" has harness=${JSON.stringify(harness)} in seats/seats.json; ${operation} is not implemented for that harness yet`);
  }
}
