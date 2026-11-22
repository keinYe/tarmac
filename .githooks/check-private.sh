#!/bin/sh
# Checks text on stdin against the maintainer's private blocklist (.private/blocklist.txt, one
# extended regex per line, case-insensitive, # comments). The list is not part of this repository;
# without it the check is skipped. Exits 1 and prints the matching lines when anything matches.
list="$(git rev-parse --show-toplevel)/.private/blocklist.txt"
[ -f "$list" ] || exit 0
patterns=$(mktemp) || exit 1
trap 'rm -f "$patterns"' EXIT
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$list" > "$patterns"
[ -s "$patterns" ] || exit 0
hits=$(grep -n -i -E -f "$patterns")
[ -z "$hits" ] && exit 0
echo "private information found in $1 (patterns from .private/blocklist.txt):" >&2
echo "$hits" >&2
exit 1
