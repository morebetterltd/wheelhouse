#!/usr/bin/env bash
# Executable dependency policy: commands are forbidden, inert fixture data isn't.
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-python-invocations.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
AUDITOR="${1:-$HERE/python-invocations.ts}"
[ -r "$AUDITOR" ] || { printf 'selftest: missing invocation auditor: %s\n' "$AUDITOR" >&2; exit 2; }
bun "$HERE/fixtures/python-invocations.ts" "$FIX" "$AUDITOR"
