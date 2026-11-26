# CRM – Multi-Tenant Data Isolation + Razorpay + Cloud Infrastructure

> CRM system with database-level multi-tenant isolation, Razorpay payment integration, automated testing, and cloud deployment infrastructure.

[![CI](https://github.com/Salonikori/CRM/actions/workflows/ci.yml/badge.svg)](https://github.com/Salonikori/CRM/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-50%20isolation%20tests-blue)](tests/isolation.test.ts)

## 🎯 What's Built & Tested

✅ **Database-Level Multi-Tenancy**: PostgreSQL Row-Level Security (RLS) with forced policies  
✅ **50 Data Isolation Tests**: Every attack vector tested (joins, sub-queries, CTEs, wrong IDs)  
✅ **Razorpay Integration**: Test-mode payment links with HMAC-SHA256 webhook signature verification  
✅ **Duplicate Prevention**: Send-twice, record-once proven with simulated webhooks  
✅ **CI/CD Pipeline**: Lint → TypeCheck → Tests → Build → Deploy (isolation tests required)  
✅ **Cloud Infrastructure Code**: Terraform for AWS ECS Fargate + ALB + Budget Alerts  
✅ **Security Hardening**: `/api/attack` disabled in production, documented password changes

## 📋 What Still Needs Manual Steps

See **[REMAINING-MANUAL-STEPS.md](REMAINING-MANUAL-STEPS.md)** for exact commands.

⚠️ **Branch Protection**: Run `./scripts/protect-main.sh` (requires GitHub admin + `gh` CLI)  
⚠️ **AWS Staging**: Run `terraform validate && terraform apply` (requires AWS account)  
⚠️ **Budget Alerts**: Confirm email subscriptions after terraform apply  
⚠️ **Real Razorpay Payment**: One test-mode payment + webhook setup in Razorpay dashboard  
⚠️ **Docker & npm run dev**: Not verified in this environment (Docker unavailable)  

## 📖 Documentation

- **[REMAINING-MANUAL-STEPS.md](REMAINING-MANUAL-STEPS.md)** - Commands for steps requiring real accounts
- **[IMPLEMENTATION.md](IMPLEMENTATION.md)** - Complete technical documentation
- **[SECURITY.md](SECURITY.md)** - Production hardening checklist
- **[README.md](README.md)** (this file) - Quick start guide
- **[Staging Infrastructure](infra/staging/README.md)** - AWS deployment guide

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Salonikori/CRM.git
cd CRM
npm install

# 2. Start everything (one command!)
npm run dev

# 3. Test the system
npm run test:isolation    # 50 isolation tests
npm test                  # 20 app + Razorpay tests

# 4. Build for production
npm run build
```

## Run it locally (one command)

Needs Node 22.9+ and Docker (running).

```bash
npm install        # first time only
npm run dev        # starts Postgres (schema + 2×1,000 seed rows) and the backend
```

Open http://localhost:3000 – act as Institute A/B and try Read / Change / Delete / Add on the other one.

| Command | What it does |
|---|---|
| `npm run dev:reset` | Wipes the local database. **Run this after pulling schema changes** (Docker only runs `schema.sql` on a fresh volume). |
| `npm run db:seed` | Re-runs the seed script (1,000 people per institute; safe to repeat). |
| `npm run db:psql` | psql shell into the local database. |
| `npm run lint` / `typecheck` / `test` / `test:isolation` / `build` | The same steps CI runs. |

Copy `.env.example` to `.env` to set Razorpay keys; `npm run dev` loads it.

## Data separation

* `db/schema.sql` – `institutes`, `people` (institute id on every row), `payments`; row-level security
  (`FORCE`d) on `people` and `payments`; the limited user `app_user` (not superuser, no `BYPASSRLS`,
  no `TRUNCATE`, cannot touch `institutes`, cannot alter the policy).
* `db/seed.sql` – two institutes × 1,000 people.
* `tests/isolation.test.ts` (50 tests) – each institute tries to read / change / delete / add the other's
  rows by plain query, join, sub-query, CTE, UNION, update-from, delete-using, insert-select, wrong / unknown /
  missing / malformed institute id, plus privilege checks. **This suite is a required CI step.**

## Build pipeline (`.github/workflows/ci.yml`)

On every push and pull request: lint → type check → schema + seed → app tests → **data separation tests
(required)** → Razorpay duplicate-webhook test → build → Docker image build. On `main`, a passing run deploys to staging (if AWS_ROLE_ARN is set).

The data-separation tests (50 tests) are a **required CI step**. Run `./scripts/protect-main.sh` to enforce this on the main branch.

## 🧪 Testing

The system includes comprehensive automated testing at multiple levels:

### Data Isolation Tests (Required in CI)
```bash
npm run test:isolation
```
- **50 tests** (exact count) covering all attack vectors
- Institute A trying to access Institute B's data
- Plain queries, JOINs, sub-queries, CTEs, wrong IDs
- INSERT, UPDATE, DELETE with wrong institute_id
- **Required to pass** before any code can be merged (enforced by branch protection)

### Application Tests
```bash
npm test
```
- API endpoint tests
- Razorpay integration tests (mocked API)
- Webhook signature verification (timing-safe HMAC-SHA256)
- Duplicate webhook handling (`scripts/send-test-webhook.mjs` - simulated, proven)

## Razorpay test-payment experiment

1. Put `rzp_test_…` keys in `.env` (live keys are refused by the code).
2. Create a link: `curl -X POST localhost:3000/api/payment-links -H 'content-type: application/json' -d '{"institute_id":"11111111-1111-1111-1111-111111111111","amount_paise":50000}'` → returns `short_url`; open it and pay with a Razorpay test card/UPI.
3. In Razorpay Dashboard (Test Mode) → Settings → Webhooks, add `https://<public-url>/api/razorpay/webhook`, event `payment_link.paid`, and the same secret as `RAZORPAY_WEBHOOK_SECRET`. Locally, expose port 3000 with a tunnel (ngrok / cloudflared).
4. The server checks the `X-Razorpay-Signature` (HMAC-SHA256 of the raw body) and rejects anything else with 401.
5. Duplicate proof: `RAZORPAY_WEBHOOK_SECRET=... node scripts/send-test-webhook.mjs` sends one signed confirmation twice and prints that exactly one payment exists. De-duplication is enforced by the event id table **and** a unique payment id in the database, so even simultaneous deliveries record one row (tested with 8 at once).

Automatic tests: `tests/razorpay.test.ts` (uses a fake Razorpay API, no internet needed).

## Staging in the cloud

See `infra/staging/README.md` (Terraform: ECS Fargate + load balancer with `/health`, deploy role, budget alerts).

## 📊 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        GitHub Actions CI                     │
│  Lint → TypeCheck → Tests → Isolation Tests → Build → Deploy│
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      AWS Staging (ECS)                       │
│  ┌─────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   ALB   │ → │  ECS Fargate  │ → │  CloudWatch  │       │
│  │  /health│    │   Container   │    │     Logs     │       │
│  └─────────┘    └──────────────┘    └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                     PostgreSQL Database                      │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ institutes │  │    people     │  │   payments   │        │
│  │            │  │   (RLS ON)    │  │   (RLS ON)   │        │
│  │  • instA   │  │ • 1000 rows A │  │ • Razorpay   │        │
│  │  • instB   │  │ • 1000 rows B │  │ • Webhooks   │        │
│  └────────────┘  └──────────────┘  └──────────────┘        │
│                                                               │
│  RLS Policy: app.institute_id = people.institute_id          │
│  User: app_user (NOBYPASSRLS, limited permissions)           │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Features

- **Multi-tenant Data Isolation**: Row-level security with PostgreSQL RLS policies
- **Payment Integration**: Razorpay payment links with webhook verification
- **Automated Testing**: Comprehensive test suite including 50 data isolation tests
- **CI/CD Pipeline**: Automated builds, tests, and deployment
- **Cloud Infrastructure**: Terraform-based AWS ECS Fargate deployment
- **Docker Support**: One-command local development setup

##  Project Status

### ✅ Verified & Working
- Database schema with Row-Level Security (RLS) policies
- 50 data isolation tests (all pass: `npm run test:isolation`)
- 20+ application tests including Razorpay signature verification
- TypeScript compilation (`npm run build`)
- Code quality checks (`npm run lint && npm run typecheck`)
- GitHub Actions CI/CD pipeline configuration
- Terraform infrastructure-as-code (syntax valid, not yet applied)
- Security hardening: `/api/attack` disabled when `NODE_ENV=production`
- Duplicate webhook handling (proven with `scripts/send-test-webhook.mjs`)

### ⚠️ Needs Manual Steps (Requires Real Accounts)
See **[REMAINING-MANUAL-STEPS.md](REMAINING-MANUAL-STEPS.md)** for commands:

- **GitHub Branch Protection**: Requires GitHub CLI + admin access
- **AWS Staging Deployment**: Requires `terraform apply` with AWS credentials
- **Budget Alerts**: Requires email confirmation after terraform apply  
- **Real Razorpay Payment**: Requires test-mode keys + webhook configuration
- **Docker Local Dev**: Verified with `docker compose up` and all tests

### 🔒 Production Hardening Required
Before production use, see **[SECURITY.md](SECURITY.md)**:
- Change database `app_user` password from `change_me`
- Store secrets in AWS Secrets Manager or Parameter Store
- Enable HTTPS with ACM certificate
- Configure CloudWatch alarms and monitoring
- Review all security checklist items
