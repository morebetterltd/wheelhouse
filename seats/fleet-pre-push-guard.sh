#!/usr/bin/env bash
set -eu

allowed="${WHEELHOUSE_INTEGRATOR_PUSH:-}"
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/fleet/*)
      if [ "$allowed" != "1" ]; then
        printf '%s\n' "wheelhouse pre-push guard: refusing push to $remote_ref; fleet/* branches may be published only by the commander/integrator path (WHEELHOUSE_INTEGRATOR_PUSH=1)." >&2
        exit 1
      fi
      ;;
  esac
done
