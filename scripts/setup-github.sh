#!/usr/bin/env bash
# One-time GitHub setup, run by a repo admin AFTER `terraform apply` (or before it, with --no-aws).
#   1. Install GitHub CLI, run `gh auth login`.
#   2. Put GitHub usernames in .github/team.txt.
#   3. ./scripts/setup-github.sh [--no-aws]
# Does: invites the team, makes the "build" check (incl. data separation tests) required on main,
# and sets the AWS_ROLE_ARN / AWS_REGION repository variables from Terraform's outputs.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Repository: $REPO"

./scripts/invite-team.sh "$REPO"
./scripts/protect-main.sh "$REPO" || echo "WARNING: branch protection failed (private repos need GitHub Pro/Team)." >&2

if [ "${1:-}" != "--no-aws" ]; then
  ARN="$(cd infra/staging && terraform output -raw github_deploy_role_arn)"
  REGION="$(cd infra/staging && terraform output -raw region)"
  gh variable set AWS_ROLE_ARN --repo "$REPO" --body "$ARN"
  gh variable set AWS_REGION --repo "$REPO" --body "$REGION"
  echo "Set AWS_ROLE_ARN and AWS_REGION. Push to main to deploy."
fi
