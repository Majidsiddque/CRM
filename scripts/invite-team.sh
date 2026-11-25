#!/usr/bin/env bash
# Invite everyone in .github/team.txt to this repository.
#   1. Install GitHub CLI and run `gh auth login` as a repo admin.
#   2. Put one GitHub username per line in .github/team.txt (# for comments).
#   3. ./scripts/invite-team.sh [owner/repo] [permission]
# permission: pull | triage | push (default) | maintain | admin
# Each person gets an email invitation and must accept it.
set -euo pipefail
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
PERM="${2:-push}"
FILE="$(dirname "$0")/../.github/team.txt"

while read -r user; do
  user="${user%%#*}"; user="$(echo "$user" | xargs)"
  [ -z "$user" ] && continue
  if gh api -X PUT "repos/$REPO/collaborators/$user" -f permission="$PERM" >/dev/null; then
    echo "invited $user to $REPO as $PERM"
  else
    echo "FAILED to invite $user" >&2
  fi
done < "$FILE"
