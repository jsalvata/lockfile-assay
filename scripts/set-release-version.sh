#!/usr/bin/env bash
# Called by semantic-release (prepare) with the version it is about to publish.
#
# Two artifacts must reference that version EXACTLY, and neither can be derived
# at run time:
#
#   action.yml                    the CLI version the composite action installs.
#                                 Without this, `uses: …@vX.Y.Z` would pin the
#                                 action but still run `lockfile-assay@latest` —
#                                 pinning would not pin the code that executes,
#                                 which is the whole point of the tool.
#   examples/lockfile-assay.yml   the action tag the reference workflow pins, so
#                                 the copy-paste example never goes stale.
#
# Both edits are verified below: a silently-failed rewrite must fail the release
# rather than ship an unpinned action.
set -euo pipefail

VER="${1:?usage: set-release-version.sh <version>}"

# NB: no `sed -i`. It is not portable — GNU takes no argument, while BSD/macOS
# consumes the next token as a backup suffix and so silently swallows `-E`,
# dropping to basic regexes (where `+` is a literal). Rewrite via a temp file so
# this behaves identically on the Linux release runner and on a maintainer's Mac.
rewrite() { # rewrite <file> <extended-regex> <replacement>
  local file="$1" ere="$2" repl="$3"
  sed -E "s|${ere}|${repl}|" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

rewrite action.yml \
  'VERSION="[^"]*" # x-release-version' \
  "VERSION=\"${VER}\" # x-release-version"

rewrite examples/lockfile-assay.yml \
  'jsalvata/lockfile-assay@v[0-9]+\.[0-9]+\.[0-9]+' \
  "jsalvata/lockfile-assay@v${VER}"

grep -q "VERSION=\"${VER}\" # x-release-version" action.yml \
  || { echo "FATAL: action.yml CLI pin was not updated to ${VER}" >&2; exit 1; }
grep -q "jsalvata/lockfile-assay@v${VER}" examples/lockfile-assay.yml \
  || { echo "FATAL: examples/lockfile-assay.yml action pin was not updated to v${VER}" >&2; exit 1; }

echo "pinned ${VER}: action.yml (CLI) + examples/lockfile-assay.yml (action tag)"
