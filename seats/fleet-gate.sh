#!/usr/bin/env bash
# fleet-gate.sh — commander liveness/dispatch nudge (a UserPromptSubmit hook).
#
# Prints, on every commander turn: how many rostered seats are live, how much
# work is ready, how much is in progress — and a loud line when seats are
# cold while ready work exists. wheelhouse/runbooks/RUNNING_THE_LOOP.md's
# "Next morning" section states the order this hook exists to enforce: seats
# up and dispatched come before any commander-owned chore (machinery sync,
# selftests, upgrades, ISA edits). This is the deterministic tooth for that
# rule — a real 2026-09-02 incident on this template's own fleet was a
# commander reading a handoff's numbered chores as its own to-do list and
# spending dozens of tool calls on one before a single seat was spawned.
#
# Degrades gracefully by design: a project with no bd, no bun, or no
# seats/adapter.ts (roster not yet provisioned, or this hook copied
# somewhere it doesn't belong) prints nothing and exits 0. This hook must
# never block or error a commander turn — it is a nudge, not a gate.
#
# Wire it as a UserPromptSubmit hook in .claude/settings.json:
#   { "hooks": { "UserPromptSubmit": [ { "matcher": "",
#       "hooks": [ { "type": "command", "command": "bash seats/fleet-gate.sh" } ] } ] } }
# generated/CLAUDE.md.example's "Standing behavior" section and
# BOOTSTRAP.md step 5 both point installers here.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
cd "$ROOT" || exit 0

command -v bd >/dev/null 2>&1 || exit 0
command -v bun >/dev/null 2>&1 || exit 0
[ -f "$HERE/adapter.ts" ] || exit 0

inbox_lag=""
if [ -f "$HERE/inbox.jsonl" ]; then
  inbox_size="$(wc -c < "$HERE/inbox.jsonl" 2>/dev/null | tr -d ' ' || echo 0)"
  inbox_cursor="$(cat "$HERE/inbox.cursor" 2>/dev/null || echo 0)"
  case "$inbox_cursor" in (*[!0-9]*|'') inbox_cursor=0;; esac
  if [ "${inbox_size:-0}" -gt "$inbox_cursor" ] 2>/dev/null; then
    lag_stats="$(node - "$HERE/inbox.jsonl" "$inbox_cursor" "$HERE/logs/herald.out.log" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const [file, cursorArg, log] = process.argv.slice(2);
const cursor = Math.max(0, Number(cursorArg) || 0);
const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(cursor) : '';
const rows = body.split(/\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
let oldest = '-';
if (rows.length) {
  const t = Date.parse(rows.map((r) => r.at).filter(Boolean).sort()[0]);
  if (Number.isFinite(t)) oldest = `${Math.max(0, Math.floor((Date.now() - t) / 1000))}s`;
}
let streak = 0;
if (fs.existsSync(log)) {
  const lines = fs.readFileSync(log, 'utf8').trimEnd().split(/\n/).filter(Boolean).slice(-200).reverse();
  for (const line of lines) {
    if (/poke deferred /.test(line)) streak++;
    else if (/poke (?:sent|escalated|dropped) /.test(line)) break;
  }
}
console.log(`${rows.length}|${oldest}|${streak}`);
NODE
)"
    IFS='|' read -r lag_rows lag_oldest lag_streak <<EOF
$lag_stats
EOF
    inbox_lag=" — INBOX LAG ${lag_rows:-0} undrained row(s), oldest ${lag_oldest:--}, herald deferral streak ${lag_streak:-0}"
  fi
fi

herald_dead=""
pid_file="$HERE/run/herald.pid"
if [ -f "$pid_file" ]; then
  hpid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$hpid" ] && ! kill -0 "$hpid" 2>/dev/null; then
    last_err="$(tail -n 1 "$HERE/logs/herald.stderr.log" 2>/dev/null || true)"
    herald_dead=" — HERALD DEAD pid $hpid${last_err:+; last stderr: $last_err}"
  fi
fi

status="$(bun "$HERE/adapter.ts" status 2>/dev/null)" || exit 0
live=$(printf '%s\n' "$status" | grep -c ' RUNNING ')
parked=$(printf '%s\n' "$status" | grep -c ' PARKED ')
quota=$(printf '%s\n' "$status" | grep -c ' CAPACITY: QUOTA ')
reprobe=$(printf '%s\n' "$status" | sed -n 's/^.*RE-PROBE: //p' | head -1)
total=$(printf '%s\n' "$status" | grep -c -E ' (RUNNING|PARKED|DIED|STOPPED) ')

# Counted from --json rather than the pretty-printed listing: the display is
# not the data (wheelhouse/fleet/WORKER.md), and bd's rendered glyphs are not
# a contract this hook can lean on across builds. One "id" field per issue —
# `grep -o | wc -l` counts occurrences rather than matching LINES, so this
# still works whether the JSON is pretty-printed (one field per line, bd's
# own shape) or compact (everything on one line, as fixtures may write it).
ready=$(bd ready --json 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')
inprog=$(bd list --status in_progress --limit 0 --json 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')
github_repo_from_remote() {
  sed -E 's#.*github\.com[:/]##; s#\.git$##'
}
product_repo_root() {
  local source_file="$ROOT/wheelhouse/.template-source" raw candidate
  if [ -f "$source_file" ]; then
    raw="$(sed -n 's/^product-repo=//p; s/^product-repos=//p; s/^product_repo=//p; s/^product_repos=//p; s/^repo=//p; s/^repos=//p' "$source_file" 2>/dev/null | tr ',:' '\n\n' | sed '/^[[:space:]]*$/d' | head -1)"
    if [ -n "$raw" ]; then
      case "$raw" in /*) candidate="$raw" ;; *) candidate="$ROOT/$raw" ;; esac
      if git -C "$candidate" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$candidate" rev-parse --show-toplevel 2>/dev/null && return 0
      fi
    fi
  fi
  if [ -d "$ROOT/template" ] && git -C "$ROOT/template" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT/template" rev-parse --show-toplevel 2>/dev/null && return 0
  elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null && return 0
  fi
  return 1
}

needs_waiting=0
unread_needs=0
if [ -f "$HERE/needs.jsonl" ]; then
  need_counts=$(bun -e '
    const fs=require("fs"); const file=process.argv[1];
    const needs=new Map();
    const ensure=(id)=>{ if(!needs.has(id)) needs.set(id,{state:null,human:null,read:null}); return needs.get(id); };
    for (const line of fs.readFileSync(file,"utf8").split(/\n/)) {
      if (!line.trim()) continue;
      let ev; try { ev=JSON.parse(line); } catch { continue; }
      if (!ev.id) continue;
      const n=ensure(ev.id);
      if (ev.type === "opened") n.state="open";
      else if (ev.type === "message" && ev.from === "human") n.human=ev.at || "";
      else if (ev.type === "answered") { n.state="answered"; n.human=ev.at || ""; }
      else if (ev.type === "closed") n.state="closed";
      else if (ev.type === "read") n.read=ev.at || "";
    }
    let open=0, unread=0;
    for (const n of needs.values()) {
      if (n.state === "open") open++;
      if (n.state !== "closed" && n.human && (!n.read || n.read < n.human)) unread++;
    }
    console.log(`${open}|${unread}`);
  ' "$HERE/needs.jsonl" 2>/dev/null || echo '0|0')
  IFS='|' read -r needs_waiting unread_needs <<EOF
$need_counts
EOF
  case "$needs_waiting" in (*[!0-9]*|'') needs_waiting=0;; esac
  case "$unread_needs" in (*[!0-9]*|'') unread_needs=0;; esac
fi

# Open GitHub issues on the product repo that no open bead traces yet. Consumer
# fleets file template defects there, and a commander that only reads `bd ready`
# never sees them (Keenan, 2026-09-22: "make sure you're watching there for work
# whenever you're active"). A bead traces an issue by carrying its URL in its
# body (GRAPH.md's `Trace:` line). Degrades to silence without gh, a remote,
# or network; never delays the turn more than one gh call.
untriaged=""
if command -v gh >/dev/null 2>&1; then
  product_root="$(product_repo_root 2>/dev/null || true)"
  if [ -n "$product_root" ]; then
    repo="$(git -C "$product_root" remote get-url origin 2>/dev/null | github_repo_from_remote)"
    if [ -n "$repo" ]; then
      open_urls="$(gh issue list -R "$repo" --state open --limit 100 --json url --jq '.[].url' 2>/dev/null || true)"
      if [ -n "$open_urls" ]; then
        traced="$(bd list --status open --limit 0 --json 2>/dev/null; bd list --status in_progress --limit 0 --json 2>/dev/null)"
        n=0; missing=""
        while IFS= read -r u; do
          [ -n "$u" ] || continue
          if ! printf '%s' "$traced" | grep -qF "$u"; then n=$((n+1)); missing="$missing #${u##*/}"; fi
        done <<EOF
$open_urls
EOF
        if [ "$n" -gt 0 ]; then
          untriaged=" — ${n} GITHUB ISSUE(S) NOT ON THE BOARD:${missing}. Triage into beads (Trace: <issue url>) before anything else: gh issue view -R $repo <n>"
        fi
      fi
    fi
  fi
fi

line="🚢 FLEET: ${live}/${total} seats live · ${ready} ready · ${inprog} in progress${herald_dead}${inbox_lag}${untriaged}"
if [ "$needs_waiting" -gt 0 ] 2>/dev/null; then
  line="$line — ${needs_waiting} need(s) waiting on a human — bun seats/needs.ts list"
fi
if [ "$unread_needs" -gt 0 ] 2>/dev/null; then
  line="$line — ${unread_needs} answer(s) waiting to be read — bun seats/needs.ts list --unread"
fi
if [ "$parked" -gt 0 ] || [ "$quota" -gt 0 ]; then
  line="$line — PARKED/QUOTA: ${quota:-0} capacity event(s). Re-probe: ${reprobe:-bun seats/adapter.ts probe <seat>}"
fi
if [ "$live" -eq 0 ] && [ "$ready" -gt 0 ]; then
  line="$line — SEATS COLD WITH READY WORK. Spawn/resume seats and dispatch FIRST. No commander chore (machinery sync, selftests, upgrades, ISA edits) before a seat holds a bead."
fi
echo "$line"
