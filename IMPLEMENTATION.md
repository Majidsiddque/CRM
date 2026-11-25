# CRM Implementation Guide

## ✅ Complete Feature Checklist

### 1. Database Schema & Data Separation ✅
- **Location**: `db/schema.sql`
- **Features**:
  - `institutes` table with UUID primary keys
  - `people` table with institute_id foreign key
  - `payments` table for Razorpay transactions
  - `webhook_events` table for deduplication
  - Row-Level Security (RLS) policies on `people` and `payments`
  - Forced RLS even for table owner
  - Restricted `app_user` role (NOBYPASSRLS, no superuser)
  - Grants only SELECT, INSERT, UPDATE, DELETE (no TRUNCATE, no DDL)

### 2. Test Data Generation ✅
- **Location**: `db/seed.sql`
- **Features**:
  - Creates 2 institutes (A and B) with fixed UUIDs
  - Generates exactly 1,000 people per institute
  - Uses generate_series for bulk insert
  - Conflict-safe (ON CONFLICT DO NOTHING)

### 3. Automated Build Pipeline ✅
- **Location**: `.github/workflows/ci.yml`
- **Pipeline Steps**:
  1. Code style check (`npm run lint`)
  2. TypeScript type checking (`npm run typecheck`)
  3. Database schema setup
  4. Seed test data (2,000 records)
  5. Application tests (`npm test`)
  6. **Data separation tests - REQUIRED** (`npm run test:isolation`)
  7. Build application (`npm run build`)
  8. Docker image build
  9. Auto-deploy to staging (on main branch only)

### 4. Data Isolation Tests ✅
- **Location**: `tests/isolation.test.ts`
- **Coverage**: 50+ tests
- **Attack Vectors Tested**:
  - Plain SELECT with wrong institute_id → 0 rows
  - UPDATE with wrong institute_id → 0 rows changed
  - DELETE with wrong institute_id → 0 rows deleted
  - INSERT into wrong institute → rejected
  - UPDATE to move row to another institute → rejected
  - JOIN queries → only own data visible
  - JOIN targeting other institute → 0 rows
  - Sub-queries and CTEs → isolated
  - UNION queries → isolated
  - UPDATE-FROM → isolated
  - DELETE-USING → isolated
  - INSERT-SELECT → rejected for wrong institute
  - Wrong/unknown/missing institute_id → 0 rows or rejection
  - Malformed institute_id → error handling

### 5. One-Command Local Development ✅
- **Command**: `npm run dev`
- **What it does**:
  1. Starts PostgreSQL 16 in Docker
  2. Auto-runs schema.sql on first start
  3. Auto-runs seed.sql (2,000 test records)
  4. Waits for database health check
  5. Starts the backend with tsx hot-reload
  6. Loads .env file automatically
- **Port**: http://localhost:3000
- **Database Port**: 55432 (not 5432, to avoid conflicts)

**Additional Commands**:
```bash
npm run dev:reset    # Wipe database (run after schema changes)
npm run db:seed      # Re-run seed script
npm run db:psql      # Open psql shell
npm run lint         # Check code style
npm run typecheck    # Check TypeScript
npm test             # Run app + Razorpay tests
npm run test:isolation  # Run data separation tests
npm run build        # Compile TypeScript
```

### 6. Team Invitation System ✅
- **Location**: `.github/team.txt` + `scripts/`
- **Files**:
  - `team.txt`: List of GitHub usernames (one per line)
  - `invite-team.sh`: Sends repo invitations
  - `protect-main.sh`: Requires "build" check before merge
  - `setup-github.sh`: One-command setup (invites + protection + AWS vars)

**Usage**:
```bash
# 1. Add usernames to .github/team.txt
# 2. Install GitHub CLI: gh auth login
# 3. Run setup
./scripts/setup-github.sh
```

### 7. Razorpay Payment Integration ✅
- **Location**: `src/razorpay.ts` + webhook endpoint
- **Features**:
  - Create TEST-mode payment links
  - HMAC-SHA256 webhook signature verification
  - Timing-safe signature comparison
  - Raw body signature validation
  - Duplicate webhook handling (event_id deduplication)
  - Duplicate payment prevention (unique razorpay_payment_id)
  - Race condition handling (concurrent webhook deliveries)
  - Institute-scoped payment recording
  - Test-only enforcement (refuses live keys)

**API Endpoints**:
```bash
# Create payment link
POST /api/payment-links
Body: {"institute_id":"...", "amount_paise":50000, "description":"Test"}

# Webhook (Razorpay → server)
POST /api/razorpay/webhook
Headers: X-Razorpay-Signature, X-Razorpay-Event-Id

# List payments for institute
GET /api/payments?institute=11111111-1111-1111-1111-111111111111
```

**Duplicate Prevention**:
1. `webhook_events` table tracks event_id (from X-Razorpay-Event-Id header)
2. `payments` table has unique constraint on razorpay_payment_id
3. Transaction ensures atomic insert into both tables
4. Even 8 simultaneous deliveries result in exactly 1 payment record

**Test Script**: `scripts/send-test-webhook.mjs`

### 8. Cloud Infrastructure (AWS) ✅
- **Location**: `infra/staging/`
- **Infrastructure as Code**: Terraform
- **Components**:
  - **ECR**: Docker image registry
  - **ECS Fargate**: Serverless containers (0.25 vCPU)
  - **Application Load Balancer**: HTTP with /health endpoint
  - **CloudWatch Logs**: 14-day retention
  - **IAM Role**: GitHub OIDC (no stored AWS keys)
  - **Budget Alerts**: Email at 50%, 80%, 100% spend + forecast
- **Region**: Mumbai (ap-south-1)
- **Cost**: ~$30/month (ALB $18-20 + Fargate $9 + logs/ECR)

**Deployment**:
```bash
cd infra/staging
cp terraform.tfvars.example terraform.tfvars
# Edit: github_repo, budget_emails
terraform init
terraform apply
# Copy outputs to GitHub Variables: AWS_ROLE_ARN, AWS_REGION
```

**Health Check**: 
- Endpoint: `GET /health`
- Response: `{"status":"running"}`
- CI verifies health check after every deployment
- Load balancer uses it for target health

**Auto-deployment**:
- Triggers on push to `main` after all tests pass
- Builds Docker image with commit SHA tag
- Pushes to ECR
- Registers new ECS task definition
- Updates service and waits for stability
- Verifies health endpoint responds with "running"

### 9. Branch Protection ✅
- **Location**: `scripts/protect-main.sh`
- **Enforcement**:
  - Requires "build" check to pass (includes data isolation tests)
  - Prevents direct push to main
  - Forces pull request workflow
- **Note**: Requires GitHub Pro/Team for private repos

## 🧪 Testing

### Application Tests
```bash
npm test
# Tests: API endpoints, Razorpay integration (mocked)
```

### Data Isolation Tests (Required for CI)
```bash
npm run test:isolation
# 50+ tests ensuring no cross-institute data access
```

### Manual Razorpay Test
```bash
# 1. Add test keys to .env
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# 2. Start server
npm run dev

# 3. Create payment link
curl -X POST http://localhost:3000/api/payment-links \
  -H 'content-type: application/json' \
  -d '{"institute_id":"11111111-1111-1111-1111-111111111111","amount_paise":50000}'

# 4. Open short_url and pay with test card

# 5. Set webhook URL in Razorpay Dashboard (use ngrok/cloudflared for local)
# Event: payment_link.paid
# URL: https://your-public-url/api/razorpay/webhook
```

## 🔒 Security Features

1. **Row-Level Security**: Postgres RLS enforced on all queries
2. **Forced RLS**: Even superuser respects policies
3. **Limited User**: app_user has no DDL, no BYPASSRLS, no superuser
4. **Webhook Signatures**: HMAC-SHA256 verification with timing-safe comparison
5. **Test-Only Payments**: Code refuses live Razorpay keys
6. **Duplicate Prevention**: Event-based and payment-id-based deduplication
7. **Institute Isolation**: Session-based institute_id setting per transaction
8. **GitHub OIDC**: No stored AWS credentials, identity federation only

## 📊 Data Model

```
institutes
├── id (UUID, PK)
└── name (VARCHAR, UNIQUE)

people (RLS enabled, forced)
├── id (UUID, PK)
├── institute_id (UUID, FK → institutes.id) [RLS key]
├── name (VARCHAR)
├── email (VARCHAR)
├── created_at (TIMESTAMP)
└── UNIQUE(institute_id, name)

payments (RLS enabled, forced)
├── id (UUID, PK)
├── institute_id (UUID, FK → institutes.id) [RLS key]
├── razorpay_payment_id (VARCHAR, UNIQUE)
├── razorpay_payment_link_id (VARCHAR)
├── amount_paise (BIGINT)
├── currency (CHAR(3))
├── status (VARCHAR)
└── created_at (TIMESTAMP)

webhook_events (no RLS - dedupe only)
├── event_id (VARCHAR, PK)
└── received_at (TIMESTAMP)
```

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Salonikori/CRM.git
cd CRM
npm install

# 2. Start everything (one command!)
npm run dev

# 3. Test data separation
npm run test:isolation

# 4. Run all tests
npm test

# 5. Build for production
npm run build
```

## 📝 Environment Variables

Create `.env` from `.env.example`:

```bash
# Database (for production only - dev uses docker-compose defaults)
DATABASE_URL=postgres://app_user:change_me@localhost:55432/postgres

# Razorpay (test mode only)
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# Optional: for mocking in tests
RAZORPAY_API_BASE=http://localhost:9999
```

## 🎯 Success Criteria - All Met! ✅

✅ Database schema with institutes and people tables  
✅ Row-level security policies that isolate data by institute  
✅ Restricted database user (app_user) with limited permissions  
✅ 1,000 test rows per institute (2 institutes = 2,000 total)  
✅ Automatic build pipeline (lint → typecheck → test → build)  
✅ One-command local development (npm run dev)  
✅ Team invitation scripts  
✅ 50+ data isolation tests covering all attack vectors  
✅ Plain queries, joins, sub-queries, CTEs, wrong IDs - all tested  
✅ Cloud infrastructure as code (Terraform)  
✅ Auto-deployment to staging on main branch  
✅ Health check endpoint (/health)  
✅ Budget alerts configured  
✅ Razorpay test payment link creation  
✅ Webhook signature verification (HMAC-SHA256)  
✅ Duplicate webhook handling (send twice, record once)  
✅ Data separation tests in required CI step  

## 🏆 Architecture Highlights

- **Multi-tenant**: Complete data isolation at database level
- **Security-first**: RLS + limited user + signature verification
- **Test-driven**: 50+ isolation tests + app tests + Razorpay tests
- **Cloud-native**: Docker + ECS Fargate + ALB
- **Infrastructure as Code**: Terraform with budget controls
- **CI/CD**: Automated testing and deployment
- **Developer-friendly**: One command to start everything

---

**All requirements implemented and tested!** 🎉
