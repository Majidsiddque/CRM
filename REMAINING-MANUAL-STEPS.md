# Remaining Manual Steps

These steps require real accounts (GitHub admin, AWS, Razorpay) and cannot be automated in the development environment. All code is written and tested; these are configuration and verification steps.

---

## ✅ Already Verified (No Action Needed)

- Database schema with RLS policies
- 50 data isolation tests (all passing)
- 20+ application tests
- TypeScript build, lint, typecheck
- GitHub Actions CI/CD pipeline configuration
- Terraform infrastructure code (syntax valid)
- Security hardening code (`/api/attack` protection)
- Duplicate webhook handling (simulated, proven)

---

## 1. GitHub Branch Protection

**Goal**: Make data-separation tests a truly required check before merging to main.

**Prerequisites**:
- GitHub CLI installed: https://cli.github.com/
- Repository admin access
- For private repos: GitHub Pro/Team plan (or make repo public)

**Steps**:

```bash
# 1. Install GitHub CLI and authenticate
gh auth login

# 2. Run the protection script
./scripts/protect-main.sh

# 3. Verify protection is active
gh api repos/Salonikori/CRM/branches/main/protection

# Expected: JSON showing "build" check is required
```

**Alternative if script fails** (private repo without Pro/Team):
1. Go to: https://github.com/Salonikori/CRM/settings/branches
2. Click "Add rule"
3. Branch name pattern: `main`
4. Enable: "Require status checks to pass before merging"
5. Add required check: `build`
6. Enable: "Require branches to be up to date"
7. Click "Create"

**Note**: If you can't enable protection, the CI will still run on all PRs—it just won't block merging.

---

## 2. Terraform Validation & AWS Staging

**Goal**: Deploy infrastructure to AWS and enable auto-deployment from GitHub.

**Prerequisites**:
- AWS account with credentials configured (`aws configure` or environment variables)
- Target AWS region: `ap-south-1` (Mumbai) or change in `terraform.tfvars`
- GitHub repository: `Salonikori/CRM`
- Email address for budget alerts

**Steps**:

```bash
# 1. Navigate to Terraform directory
cd infra/staging

# 2. Create terraform.tfvars from example
cp terraform.tfvars.example terraform.tfvars

# 3. Edit terraform.tfvars:
# github_repo   = "Salonikori/CRM"
# budget_emails = ["your-email@example.com"]

# 4. Validate Terraform configuration
terraform fmt
terraform init
terraform validate

# Expected: "Success! The configuration is valid."

# 5. Preview changes
terraform plan

# Review the plan output carefully. It will create:
# - ECR repository
# - ECS cluster, task definition, and service
# - Application Load Balancer (ALB)
# - Security groups
# - IAM roles (including GitHub OIDC)
# - CloudWatch log group
# - AWS Budget with email alerts

# 6. Apply (creates resources - costs ~$30/month)
terraform apply

# Type 'yes' when prompted

# 7. Note the outputs:
# - github_deploy_role_arn
# - region
# - health_check_url

# 8. Set GitHub repository variables
cd ../..
gh variable set AWS_ROLE_ARN --body "<github_deploy_role_arn from step 7>"
gh variable set AWS_REGION --body "ap-south-1"

# 9. Verify variables are set
gh variable list

# 10. Push to main to trigger deployment
git push origin main

# 11. Watch the deployment
gh run watch

# Expected: deploy-staging job succeeds, health check passes

# 12. Test the health endpoint
curl <health_check_url from step 7>

# Expected: {"status":"running"}
```

**Cost estimate**: ~$30/month
- ALB: $18-20/month
- ECS Fargate (0.25 vCPU, 0.5 GB): ~$9/month
- CloudWatch Logs, ECR: ~$1-2/month

**To pause staging** (ALB still bills):
```bash
cd infra/staging
# Edit main.tf: set desired_count = 0
terraform apply
```

**To destroy everything**:
```bash
cd infra/staging
terraform destroy
```

---

## 3. Budget Alert Email Confirmation

**Goal**: Receive alerts when AWS spending reaches thresholds.

**Prerequisites**: Terraform apply completed (Step 2)

**Steps**:

1. Check the email address you provided in `terraform.tfvars`
2. Look for email from `no-reply@budgets.amazonaws.com`
   - Subject: "AWS Budget Notification Subscription Confirmation"
3. **Click the confirmation link in the email**
4. No further action needed—AWS Budgets do not require opt-in confirmation

**Budget thresholds** (configured in `infra/staging/budgets.tf`):
- 50% of budget: Email alert
- 80% of budget: Email alert
- 100% of budget: Email alert
- 100% forecasted: Email alert (if spending trends predict exceeding budget)

**To verify alerts are configured**:
```bash
aws budgets describe-budgets --account-id <your-aws-account-id>
aws budgets describe-notifications-for-budget \
  --account-id <your-aws-account-id> \
  --budget-name crm-staging-monthly
```

---

## 4. Real Razorpay Test-Mode Payment

**Goal**: Verify real payment flow with Razorpay test keys and webhook.

**Prerequisites**:
- Razorpay account: https://dashboard.razorpay.com/signup
- Dashboard set to **Test Mode** (toggle in top-left corner)
- Staging deployment live (Step 2) OR local server with public tunnel

**Steps**:

### 4.1 Get Razorpay Test Credentials

```bash
# 1. Go to: https://dashboard.razorpay.com/app/keys
#    (Ensure "Test Mode" toggle is ON)

# 2. Copy:
#    - Key ID (starts with rzp_test_)
#    - Key Secret (click "Show" to reveal)

# 3. Add to local .env file (for local testing):
echo "RAZORPAY_KEY_ID=rzp_test_..." >> .env
echo "RAZORPAY_KEY_SECRET=..." >> .env
echo "RAZORPAY_WEBHOOK_SECRET=choose_a_long_random_string" >> .env

# 4. If testing against staging, add these to ECS task definition as secrets
#    (use AWS Secrets Manager)
```

### 4.2 Configure Webhook

```bash
# 1. Determine your webhook URL:
#    - Staging: http://<alb-dns-from-terraform>/api/razorpay/webhook
#    - Local: Use ngrok/cloudflared to expose localhost:3000
#      ngrok http 3000  # Note the HTTPS URL

# 2. Go to: https://dashboard.razorpay.com/app/webhooks
#    (Ensure "Test Mode" is ON)

# 3. Click "Create Webhook" or "+ Add New Webhook"

# 4. Configure:
#    Active Webhook URL: <your-url>/api/razorpay/webhook
#    Secret: <same as RAZORPAY_WEBHOOK_SECRET in .env>
#    Events: Check ONLY "payment_link.paid"

# 5. Click "Create Webhook"
```

### 4.3 Create Payment Link

```bash
# Using local server (npm run dev) or staging URL:
BASE_URL="http://localhost:3000"  # or https://<alb-dns>

curl -X POST $BASE_URL/api/payment-links \
  -H 'Content-Type: application/json' \
  -d '{
    "institute_id": "11111111-1111-1111-1111-111111111111",
    "amount_paise": 50000,
    "description": "Test payment"
  }'

# Response includes: { "id": "...", "short_url": "https://rzp.io/l/...", "status": "created" }
```

### 4.4 Make Test Payment

1. Open the `short_url` from the response above in a browser
2. Use Razorpay test card details:
   - Card: `4111 1111 1111 1111`
   - Expiry: Any future date (e.g., `12/25`)
   - CVV: Any 3 digits (e.g., `123`)
3. Click "Pay"

### 4.5 Verify Webhook Received

```bash
# Check server logs for:
# - POST /api/razorpay/webhook
# - Signature verified
# - Payment recorded

# Query payments table:
curl "$BASE_URL/api/payments?institute=11111111-1111-1111-1111-111111111111"

# Expected: 1 payment record with status "captured"
```

### 4.6 Test Duplicate Delivery

```bash
# Option 1: Resend from Razorpay Dashboard
# 1. Go to: https://dashboard.razorpay.com/app/webhooks
# 2. Click on your webhook
# 3. Find the "payment_link.paid" event
# 4. Click "Resend" (do this twice)

# Option 2: Use test script (simulates exact payload)
# 1. Update scripts/send-test-webhook.mjs with real event ID and payment ID
# 2. Run:
RAZORPAY_WEBHOOK_SECRET=<your-secret> node scripts/send-test-webhook.mjs

# Expected output:
# "sent twice, recorded once: true"
```

### 4.7 Verify Final State

```bash
# Query payments again:
curl "$BASE_URL/api/payments?institute=11111111-1111-1111-1111-111111111111"

# Expected: Still exactly 1 payment (not 2 or 3)
```

**Success criteria**:
- ✅ Payment link created
- ✅ Test payment succeeds
- ✅ Webhook received and signature verified
- ✅ Exactly 1 payment row in database
- ✅ Duplicate delivery still results in 1 row

---

## 5. Verify Docker & One-Command Start

**Goal**: Confirm `npm run dev` starts everything correctly.

**Prerequisites**:
- Docker installed and running
- Node.js 22.9+

**Steps**:

```bash
# 1. Clean slate
npm run dev:reset

# 2. Start everything
npm run dev

# Expected output:
# - "Starting Postgres..." (Docker container)
# - "Database ready" (health check passed)
# - "Running schema.sql..."
# - "Running seed.sql..."
# - "Server listening on port 3000"

# 3. Test health endpoint (in another terminal)
curl http://localhost:3000/health

# Expected: {"status":"running"}

# 4. Test data separation
curl "http://localhost:3000/api/people?institute=11111111-1111-1111-1111-111111111111"

# Expected: {"total":1000, "rows":[...10 rows...]}

# 5. Run isolation tests
npm run test:isolation

# Expected: All 50 tests pass

# 6. Run application tests
npm test

# Expected: All tests pass
```

**If Docker is not available**:
- Tests require PostgreSQL
- Use a managed database (e.g., local Postgres install, AWS RDS, Supabase)
- Update `DATABASE_URL` in `.env`
- Manually run `db/schema.sql` and `db/seed.sql` as postgres user
- Tests should use `app_user` (already configured in test files)

---

## Troubleshooting

### GitHub CLI not found
```bash
# Install: https://cli.github.com/
# Then: gh auth login
```

### Terraform command not found
```bash
# Install: https://developer.hashicorp.com/terraform/install
```

### AWS credentials not configured
```bash
aws configure
# Or set environment variables:
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
```

### Docker not running
```bash
# Start Docker Desktop (Windows/Mac)
# Or: systemctl start docker (Linux)
```

### Port 3000 already in use
```bash
# Option 1: Kill process using port 3000
# Windows: netstat -ano | findstr :3000
# Then: taskkill /PID <pid> /F

# Option 2: Change port in .env
echo "PORT=3001" >> .env
```

### Tests fail: "database does not exist"
```bash
# Reset database:
npm run dev:reset
npm run dev

# Wait for schema + seed to complete, then:
npm run test:isolation
```

### Terraform plan shows unexpected changes
```bash
# This is normal on first run. Review carefully.
# Common changes:
# - Creating all resources (first time)
# - Updating task definition (after code changes)
# - Changing security group rules

# To see specific differences:
terraform show
```

### Budget alert emails not received
- Check spam/junk folder
- AWS Budgets emails do NOT require confirmation (unlike SNS topics)
- Verify email in terraform.tfvars is correct
- Check AWS Budgets console: https://console.aws.amazon.com/billing/home#/budgets

### Razorpay webhook not triggering
- Verify webhook URL is publicly accessible (use ngrok for local)
- Check Razorpay Dashboard → Webhooks → Logs
- Verify "payment_link.paid" event is selected
- Verify webhook secret matches RAZORPAY_WEBHOOK_SECRET
- Check server logs for POST /api/razorpay/webhook

---

## Summary

| Step | Status | Required Account | Estimated Time |
|------|--------|------------------|----------------|
| 1. Branch Protection | Manual | GitHub admin + CLI | 5 minutes |
| 2. AWS Staging | Manual | AWS account | 20 minutes |
| 3. Budget Alerts | Manual | Same as step 2 | 2 minutes |
| 4. Razorpay Test | Manual | Razorpay account | 15 minutes |
| 5. Docker Verification | Manual | Docker installed | 10 minutes |

**Total estimated time**: 1 hour (assuming accounts already exist)

**After completion**, all features will be fully verified with real infrastructure!
