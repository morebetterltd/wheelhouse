#!/usr/bin/env bash
# evidence-scrub.sh — redact machine-local paths as evidence is written.
#
# Usage:
#   command 2>&1 | seats/evidence-scrub.sh > evidence/<bead>/run.txt
#   seats/evidence-scrub.sh -o evidence/<bead>/run.txt -- command args...
#   . seats/evidence-scrub.sh; scrub_evidence < raw.txt > scrubbed.txt
#
# Redacts $TMPDIR, /var/folders paths, $HOME, and the local username to the
# placeholders GRAPH.md requires before committed evidence enters the repo.

scrub_evidence() {
  local home tmp user home_base tmp_phys home_phys
  home="${HOME:-}"
  tmp="${TMPDIR:-/tmp}"
  user="$(id -un 2>/dev/null || true)"
  home_base="${home##*/}"
  tmp_phys="$(cd "$tmp" 2>/dev/null && pwd -P || printf '%s' "$tmp")"
  home_phys="$(cd "$home" 2>/dev/null && pwd -P || printf '%s' "$home")"

  HOME_RAW="$home" HOME_PHYS="$home_phys" TMP_RAW="$tmp" TMP_PHYS="$tmp_phys" USER_RAW="$user" HOME_BASE="$home_base" \
  perl -Mstrict -Mwarnings -pe '
    BEGIN {
      our @literal = grep { defined($_) && length($_) } (
        $ENV{TMP_RAW}, $ENV{TMP_PHYS},
        ($ENV{TMP_RAW}  // "") =~ s{^/private/}{/}r,
        ($ENV{TMP_PHYS} // "") =~ s{^/private/}{/}r,
        ($ENV{TMP_RAW}  // "") =~ m{^/} ? "/private$ENV{TMP_RAW}"  : "",
        ($ENV{TMP_PHYS} // "") =~ m{^/} ? "/private$ENV{TMP_PHYS}" : "",
        $ENV{HOME_RAW}, $ENV{HOME_PHYS},
        ($ENV{HOME_RAW}  // "") =~ s{^/private/}{/}r,
        ($ENV{HOME_PHYS} // "") =~ s{^/private/}{/}r,
        ($ENV{HOME_RAW}  // "") =~ m{^/} ? "/private$ENV{HOME_RAW}"  : "",
        ($ENV{HOME_PHYS} // "") =~ m{^/} ? "/private$ENV{HOME_PHYS}" : "",
      );
      my %seen;
      @literal = sort { length($b) <=> length($a) } grep { !$seen{$_}++ } @literal;
      our $user = $ENV{USER_RAW} // "";
      our $home_base = $ENV{HOME_BASE} // "";
    }
    our (@literal, $user, $home_base);
    for my $p (@literal) {
      next if $p eq "/";
      my $replacement = ($p =~ m{(?:^|/)var/folders(?:/|$)} || $p =~ m{(?:^|/)tmp(?:/|$)}) ? "[tmpdir]" : "[home]";
      s/\Q$p\E/$replacement/g;
    }
    s{/(?:private/)?var/folders/[^[:space:]"'"'"'`)>,;]+}{[tmpdir]}g;
    s{\Q$user\E}{[user]}g if length($user);
    s{\Q$home_base\E}{[user]}g if length($home_base) && $home_base ne $user;
  '
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

if [ "${1:-}" = "-o" ]; then
  out="${2:-}"
  [ -n "$out" ] || { echo "usage: evidence-scrub.sh -o <output-file> -- <command...>" >&2; exit 2; }
  shift 2
  [ "${1:-}" = "--" ] || { echo "usage: evidence-scrub.sh -o <output-file> -- <command...>" >&2; exit 2; }
  shift
  [ "$#" -gt 0 ] || { echo "usage: evidence-scrub.sh -o <output-file> -- <command...>" >&2; exit 2; }
  mkdir -p "$(dirname "$out")"
  "$@" 2>&1 | scrub_evidence > "$out"
  exit "${PIPESTATUS[0]}"
fi

if [ "$#" -ne 0 ]; then
  echo "usage: evidence-scrub.sh [-o <output-file> -- <command...>] < input > output" >&2
  exit 2
fi

scrub_evidence
