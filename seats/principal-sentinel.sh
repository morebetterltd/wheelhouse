#!/bin/bash
# Claude Code Stop-hook bridge for commander-to-principal needs.
#
# Wire it from the project root in .claude/settings.json as:
# {"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash seats/principal-sentinel.sh"}]}]}}
#
# Claude Code sends one JSON object on stdin. This hook reads the final
# assistant message from last_assistant_message when present, otherwise from
# the last transcript_path record whose top-level type is "assistant". If a
# line begins "@principal:", the block from that line to the end of the
# assistant message is opened as a durable need with bun seats/needs.ts.
#
# The hook must never block Claude Code's Stop event: every path exits 0. It is
# deliberately silent when bun, seats/needs.ts, or the transcript is absent, and
# when Claude reports stop_hook_active=true.

set +e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
NEEDS="$SCRIPT_DIR/needs.ts"

command -v bun >/dev/null 2>&1 || exit 0
[ -f "$NEEDS" ] || exit 0

NEEDS_PATH="$NEEDS" bun -e '
const fs = require("fs");
const cp = require("child_process");

async function main() {
  let raw = "";
  try { raw = await Bun.stdin.text(); } catch { return; }
  let hook;
  try { hook = JSON.parse(raw || "{}"); } catch { return; }
  if (hook?.stop_hook_active === true) return;

  const transcript = typeof hook?.transcript_path === "string" ? hook.transcript_path : "";
  if (!transcript || !fs.existsSync(transcript)) return;

  let last = null;
  try {
    for (const line of fs.readFileSync(transcript, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type === "assistant") last = rec;
    }
  } catch { return; }
  if (!last) return;

  let text = "";
  if (typeof hook?.last_assistant_message === "string" && hook.last_assistant_message.length) {
    text = hook.last_assistant_message;
  } else {
    const content = last?.message?.content;
    if (Array.isArray(content)) text = content.filter((p) => p?.type === "text" && typeof p?.text === "string").map((p) => p.text).join("\n");
    else if (typeof content === "string") text = content;
  }
  if (!text) return;

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((line) => /^@principal:/.test(line));
  if (idx < 0) return;
  const block = lines.slice(idx).join("\n").trimEnd() + "\n";

  const session = typeof hook?.session_id === "string" && hook.session_id ? hook.session_id : (typeof last?.sessionId === "string" ? last.sessionId : "unknown-session");
  const uuid = typeof last?.uuid === "string" && last.uuid ? last.uuid : (typeof last?.message?.id === "string" ? last.message.id : "unknown-message");
  if (uuid === "unknown-message") return;
  const source = `${session}:${uuid}`;

  try {
    cp.spawnSync("bun", [process.env.NEEDS_PATH, "open", "--from-stdin", "--source", source], { input: block, stdio: ["pipe", "ignore", "ignore"] });
  } catch { return; }
}
main().catch(() => {});
' >/dev/null 2>&1

exit 0
