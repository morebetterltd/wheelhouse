#!/usr/bin/env bun
/** Hook-side local JSON check. No graph, repository discovery, or network. */
import fs from "node:fs";
const [file, bead, tip] = process.argv.slice(2);
try {
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  const valid = receipt?.bead === bead && receipt.tip === tip && receipt.result === "PASS"
    && receipt.review?.tip === tip && receipt.review?.verdict === "APPROVE"
    && Array.isArray(receipt.outcomes) && receipt.outcomes.length > 0
    && receipt.outcomes.every((row: any) => row && (row.result === "PASS" || (row.required === false && row.result === "SKIPPED")));
  process.exitCode = valid ? 0 : 1;
} catch { process.exitCode = 1; }
