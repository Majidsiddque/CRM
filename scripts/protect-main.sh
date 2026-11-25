#!/usr/bin/env bash
# Makes the CI check (which includes the data separation tests) REQUIRED:
# nothing can be merged into main unless the "build" job passes.
#   ./scripts/protect-main.sh [owner/repo]
# Needs repo admin rights. Branch protection on private repos needs GitHub Pro/Team.
set -euo pipefail
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["build"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null
}
JSON
echo "main on $REPO now requires: build (lint, types, tests, data separation, build)"
