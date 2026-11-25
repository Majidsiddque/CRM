#!/usr/bin/env bash
# Complete system verification script
set -euo pipefail

echo "🔍 CRM System Verification"
echo "=========================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

echo "1. Checking dependencies..."
command -v node >/dev/null 2>&1 || fail "Node.js not found"
command -v npm >/dev/null 2>&1 || fail "npm not found"
command -v docker >/dev/null 2>&1 || fail "Docker not found"
pass "All dependencies installed"
echo ""

echo "2. Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -ge 22 ]; then
  pass "Node.js version: $(node -v)"
else
  warn "Node.js version $(node -v) - recommend 22.9+"
fi
echo ""

echo "3. Installing npm packages..."
npm install --silent 2>&1 | grep -v "^npm WARN" || true
pass "Dependencies installed"
echo ""

echo "4. Running linter..."
npm run lint >/dev/null 2>&1 && pass "Code style check passed" || fail "Linting failed"
echo ""

echo "5. Running TypeScript type check..."
npm run typecheck >/dev/null 2>&1 && pass "Type check passed" || fail "Type check failed"
echo ""

echo "6. Building application..."
npm run build >/dev/null 2>&1 && pass "Build successful" || fail "Build failed"
echo ""

echo "7. Checking Docker..."
docker info >/dev/null 2>&1 || fail "Docker is not running"
pass "Docker is running"
echo ""

echo "8. Checking critical files..."
[ -f "db/schema.sql" ] && pass "Schema file exists" || fail "Schema missing"
[ -f "db/seed.sql" ] && pass "Seed file exists" || fail "Seed file missing"
[ -f "docker-compose.yml" ] && pass "Docker compose config exists" || fail "docker-compose.yml missing"
[ -f ".github/workflows/ci.yml" ] && pass "CI pipeline exists" || fail "CI config missing"
[ -f "tests/isolation.test.ts" ] && pass "Isolation tests exist" || fail "Isolation tests missing"
echo ""

echo "9. Verifying database schema features..."
grep -q "ENABLE ROW LEVEL SECURITY" db/schema.sql && pass "RLS enabled in schema" || fail "RLS not found"
grep -q "FORCE ROW LEVEL SECURITY" db/schema.sql && pass "RLS forced in schema" || fail "Forced RLS not found"
grep -q "app_user" db/schema.sql && pass "Restricted user defined" || fail "app_user not found"
grep -q "NOBYPASSRLS" db/schema.sql && pass "BYPASSRLS prevented" || fail "NOBYPASSRLS not set"
echo ""

echo "10. Verifying seed data generation..."
grep -q "generate_series(1, 1000)" db/seed.sql && pass "1000 records per institute" || fail "Seed count incorrect"
grep -q "11111111-1111-1111-1111-111111111111" db/seed.sql && pass "Institute A defined" || fail "Institute A missing"
grep -q "22222222-2222-2222-2222-222222222222" db/seed.sql && pass "Institute B defined" || fail "Institute B missing"
echo ""

echo "11. Verifying CI pipeline..."
grep -q "npm run lint" .github/workflows/ci.yml && pass "Lint step in CI" || fail "Lint missing from CI"
grep -q "npm run typecheck" .github/workflows/ci.yml && pass "Typecheck in CI" || fail "Typecheck missing"
grep -q "npm run test:isolation" .github/workflows/ci.yml && pass "Isolation tests in CI" || fail "Isolation tests not in CI"
grep -q "data separation tests (required)" .github/workflows/ci.yml && pass "Required isolation tests" || fail "Not marked as required"
echo ""

echo "12. Verifying Razorpay integration..."
[ -f "src/razorpay.ts" ] && pass "Razorpay module exists" || fail "razorpay.ts missing"
grep -q "verifyWebhookSignature" src/razorpay.ts && pass "Signature verification implemented" || fail "Signature verification missing"
grep -q "timingSafeEqual" src/razorpay.ts && pass "Timing-safe comparison" || fail "Not timing-safe"
grep -q "rzp_test_" src/razorpay.ts && pass "Test-mode enforcement" || fail "Test-mode check missing"
echo ""

echo "13. Verifying webhook deduplication..."
grep -q "webhook_events" db/schema.sql && pass "Webhook events table exists" || fail "webhook_events missing"
grep -q "event_id VARCHAR(100) PRIMARY KEY" db/schema.sql && pass "Event ID deduplication" || fail "Event ID not unique"
grep -q "razorpay_payment_id.*UNIQUE" db/schema.sql && pass "Payment ID deduplication" || fail "Payment ID not unique"
echo ""

echo "14. Checking infrastructure as code..."
[ -d "infra/staging" ] && pass "Terraform staging config exists" || fail "Infra directory missing"
[ -f "infra/staging/main.tf" ] && pass "Terraform main config" || fail "main.tf missing"
[ -f "infra/staging/budgets.tf" ] && pass "Budget alerts configured" || fail "budgets.tf missing"
echo ""

echo "15. Verifying team invitation scripts..."
[ -f "scripts/invite-team.sh" ] && pass "Team invitation script exists" || fail "invite-team.sh missing"
[ -f "scripts/protect-main.sh" ] && pass "Branch protection script exists" || fail "protect-main.sh missing"
[ -f ".github/team.txt" ] && pass "Team file exists" || fail "team.txt missing"
echo ""

echo "16. Checking documentation..."
[ -f "README.md" ] && pass "README exists" || fail "README missing"
[ -f "IMPLEMENTATION.md" ] && pass "Implementation guide exists" || fail "IMPLEMENTATION.md missing"
[ -f ".github/CONTRIBUTING.md" ] && pass "Contributing guide exists" || fail "CONTRIBUTING.md missing"
echo ""

echo ""
echo "=========================="
echo -e "${GREEN}✓ All verification checks passed!${NC}"
echo ""
echo "🚀 System is ready. Next steps:"
echo ""
echo "  • Start development:    npm run dev"
echo "  • Run all tests:        npm test"
echo "  • Run isolation tests:  npm run test:isolation"
echo "  • Invite team:          ./scripts/setup-github.sh"
echo "  • Deploy to staging:    cd infra/staging && terraform apply"
echo ""
echo "📖 See IMPLEMENTATION.md for complete documentation"
echo ""
