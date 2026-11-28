# CRM Application

A production-ready multi-tenant CRM system with secure payment processing and comprehensive student management. Built with Express, PostgreSQL row-level security, and a modern web interface.

[![CI](https://github.com/Majidsiddque/CRM/actions/workflows/ci.yml/badge.svg)](https://github.com/Majidsiddque/CRM/actions/workflows/ci.yml)

## Features

- **Full-featured CRM interface** with dashboard, student management, courses, and enquiries
- **Multi-tenant architecture** with PostgreSQL Row-Level Security (RLS)
- **Secure payment processing** via Razorpay with webhook verification
- **Complete test coverage** (131 tests: 24 application + 88 isolation + 19 CRM API tests)
- **Production deployment** on AWS ECS with Terraform
- **CI/CD pipeline** with GitHub Actions
- **Docker support** for local development

## Tech Stack

- **Runtime**: Node.js 22
- **Framework**: Express + TypeScript
- **Database**: PostgreSQL 16 with RLS
- **Payment**: Razorpay
- **Testing**: Vitest
- **Infrastructure**: AWS (ECS, ECR, ALB, RDS)
- **IaC**: Terraform
- **CI/CD**: GitHub Actions

## Quick Start

### Prerequisites

- Node.js 22+
- Docker Desktop
- Razorpay test account

### Local Development

1. **Clone and install dependencies**:
   ```bash
   git clone https://github.com/Majidsiddque/CRM.git
   cd CRM
   npm install
   ```

2. **Configure environment** - Create `.env` file:
   ```bash
   DATABASE_URL=postgres://app_user:change_me@127.0.0.1:55432/postgres
   PORT=3000
   
   # Razorpay TEST mode credentials
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   RAZORPAY_WEBHOOK_SECRET=...
   ```

3. **Start development server**:
   ```bash
   npm run dev
   ```
   This starts Docker Postgres and the Express server on port 3000.

4. **Open the CRM** in your browser:
   - CRM Application: http://localhost:3000
   - **Payment Page: http://localhost:3000/pay** 💳
   - **Security Demo: http://localhost:3000/security-demo.html** ⭐
   - API Demo: http://localhost:3000/demo.html
   - Health Check: http://localhost:3000/health

5. **Reset database** (wipes all data):
   ```bash
   npm run dev:reset
   ```

### Testing

```bash
# Run all tests (127 total)
npm test                # Application tests (20)
npm run test:isolation  # RLS security tests (88)

# Type checking
npm run typecheck

# Linting
npm run lint

# Build
npm run build
```

## Using the CRM

After starting the development server (`npm run dev`), open http://localhost:3000 in your browser.

### 🔒 Security Demo Page

**Visit http://localhost:3000/security-demo.html** for an interactive demonstration of all data separation features:

- Live database statistics (1000+ rows per institute)
- Attack simulation tests (read, update, delete, insert attacks)
- Table isolation verification (students, courses, enquiries, payments)
- Database schema and RLS policy details
- Automated test results (127 tests)
- Razorpay integration status
- Cloud deployment health checks

This page demonstrates all the requirements: database schema, row-level security policies, 1000 test rows per institute, limited database user, automated tests covering all attack vectors, CI/CD pipeline with required security tests, Razorpay payment integration with signature verification, and AWS deployment with health checks and budget alerts.

### 💳 Payment Page

**Visit http://localhost:3000/pay** for a checkout-style payment experience:

- **Professional UI**: Navy order summary panel + white payment form
- **Four screens**: Form → Waiting → Success/Failure
- **Smart polling**: Opens Razorpay in new tab, polls status every 3 seconds
- **Cannot be tricked**: Status comes from database only (via signed webhook), never from browser
- **Institute isolation**: Each institute's payments are separated
- **Test mode**: Honest "TEST MODE" banner, uses test cards only
- **Keyboard accessible**: Full focus management and ARIA labels

**How it works:**
1. User fills form (institute, amount, description)
2. Clicks "Pay" → Creates Razorpay payment link
3. Opens Razorpay page in new tab
4. Page polls `/api/payment-links/:id/status` every 3 seconds
5. When webhook confirms payment → Shows success receipt
6. 10-minute timeout if no confirmation

**Test cards:**
- Card: `4111 1111 1111 1111`, any future expiry, any CVV
- UPI: `success@razorpay` (success) or `failure@razorpay` (failure)

**Security:**
- Payment status endpoint respects RLS (Institute A cannot see B's payments)
- Signature verification prevents fake webhooks
- Idempotent webhook handling (duplicate confirmations ignored)
- 4 automated tests verify isolation and polling flow

### Main CRM Features

1. **Dashboard**
   - Real-time statistics: total students, active/pending/inactive counts
   - Total enquiries and fees collected
   - Monthly admissions chart

2. **Students Management**
   - View all students with search, filter, and pagination
   - Add new students with course selection
   - Delete students
   - Filter by status (Active, Pending, Inactive)

3. **Courses**
   - View available courses with icons, descriptions, fees, and enrollment

4. **Enquiries**
   - View and track prospective student enquiries
   - Add new enquiries
   - Move enquiries through pipeline stages (Lead → Follow-up → Admission)

5. **Institute Switcher**
   - Dropdown in header to switch between institutes
   - Each institute sees only its own data (enforced by RLS)
   - Test Institute IDs:
     - Institute A: `11111111-1111-1111-1111-111111111111`
     - Institute B: `22222222-2222-2222-2222-222222222222`

6. **Theme Toggle**
   - Light/dark mode toggle
   - Respects system preference by default
   - Persists choice in localStorage

7. **Keyboard Shortcuts**
   - Press `/` to focus search box

## API Endpoints

### CRM Frontend
```
GET /                   # CRM application
GET /pay                # Payment checkout page
GET /security-demo.html # Security demonstration
GET /demo.html          # API demo page
GET /health             # Health check
```

### Payment Status (Polling)
```
GET /api/payment-links/:id/status?institute=<uuid>
Response: { paid: boolean, payment: { razorpay_payment_id, amount_paise, currency, status, created_at } | null }
```

### Dashboard
```
GET /api/dashboard
Headers: X-Institute-Id: <institute_uuid>
```

### Students
```
GET /api/students?search=&status=&page=0&pageSize=8
POST /api/students
DELETE /api/students/:id
Headers: X-Institute-Id: <institute_uuid>
```

### Courses
```
GET /api/courses
Headers: X-Institute-Id: <institute_uuid>
```

### Enquiries
```
GET /api/enquiries
POST /api/enquiries
PATCH /api/enquiries/:id/advance
Headers: X-Institute-Id: <institute_uuid>
```

### Payment Links
```
POST /api/payment-links
Body: {
  "institute_id": "uuid",
  "amount_paise": 50000,
  "description": "Payment description"
}
```

### List Payments
```
GET /api/payments?institute=<institute_id>
```

### Webhook (Razorpay)
```
POST /api/razorpay/webhook
```

## Multi-Tenant Security

The system enforces **strict data isolation** using PostgreSQL Row-Level Security:

- Each institute can only access its own data
- 88 automated tests verify isolation across all attack vectors
- Attempts to read, modify, or delete another institute's data are blocked
- Database user is restricted (non-superuser, cannot bypass RLS)
- RLS policies enforce isolation for all tables: people, students, courses, enquiries, payments

**Test Institute IDs**:
- Institute A: `11111111-1111-1111-1111-111111111111`
- Institute B: `22222222-2222-2222-2222-222222222222`

## Payment Flow

1. Create payment link via POST `/api/payment-links`
2. Customer completes payment on Razorpay
3. Razorpay sends webhook to `/api/razorpay/webhook`
4. Server verifies HMAC-SHA256 signature
5. Payment recorded with idempotency (duplicate webhooks handled)

## Deployment

### AWS Staging

Infrastructure is deployed on AWS using Terraform:

```bash
cd infra/staging
terraform init
terraform plan
terraform apply  # Only after review
```

**Staging Environment**: http://crm-staging-alb-2117377061.ap-southeast-2.elb.amazonaws.com/health

### CI/CD

GitHub Actions automatically:
- Runs linting and type checking
- Executes all 127 tests (20 app + 88 isolation + 19 CRM API)
- Builds Docker image
- Deploys to staging (on main branch)

**Required GitHub Repository Variables**:
- `AWS_ROLE_ARN`: IAM role for GitHub Actions deployment
- `AWS_REGION`: `ap-southeast-2` (optional, defaults to ap-south-1)

## Project Structure

```
├── public/
│   ├── crm.html         # Main CRM application interface
│   └── demo.html        # API demo page
├── src/
│   ├── app.ts           # Express app with routes
│   ├── index.ts         # Server entry point
│   └── razorpay.ts      # Payment integration
├── db/
│   ├── schema.sql       # Database schema with RLS
│   └── seed.sql         # Test data (2 institutes, students, courses, enquiries)
├── tests/
│   ├── api.test.ts      # Application tests (20)
│   ├── razorpay.test.ts # Payment tests
│   ├── isolation.test.ts # RLS security tests (88)
│   └── crm.test.ts      # CRM API tests (19)
├── infra/staging/       # Terraform AWS infrastructure
├── .github/workflows/   # CI/CD pipeline
└── scripts/             # Utility scripts
```

## Development Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with Docker Postgres |
| `npm run dev:reset` | Wipe database and restart |
| `npm test` | Run all tests (127 total) |
| `npm run test:isolation` | Run RLS security tests (88) |
| `npm run lint` | Check code style |
| `npm run typecheck` | TypeScript validation |
| `npm run build` | Compile TypeScript |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `PORT` | Server port (default: 3000) | No |
| `RAZORPAY_KEY_ID` | Razorpay test API key | Yes |
| `RAZORPAY_KEY_SECRET` | Razorpay test secret | Yes |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook HMAC secret | Yes |

## Testing Payments

For local webhook testing with Razorpay:

1. Start server: `npm run dev`
2. Create tunnel: `cloudflared tunnel --url http://localhost:3000`
3. Configure webhook in Razorpay dashboard with tunnel URL
4. Create payment link and complete test payment
5. Verify webhook delivery in server logs

**Test Cards**:
- Mastercard: `5267 3181 8797 5449` (any future expiry, any CVV)
- UPI: `success@razorpay`

## Contributing

1. Create a feature branch
2. Make changes with tests
3. Ensure all tests pass: `npm test && npm run test:isolation`
4. Run lint and typecheck: `npm run lint && npm run typecheck`
5. Submit pull request

## License

MIT

## Support

For issues and questions, please open a GitHub issue.

## Attendance, video storage, and background jobs experiments

The machine intake routes are `GET /iclock/cdata`, `GET /iclock/getrequest`, and `POST /iclock/cdata?SN=<serial>&table=ATTLOG`. Point the device at the public staging origin plus `/iclock/cdata` only after confirming the staging version contains this route. In local development, use `node scripts/fake-machine.mjs http://127.0.0.1:3000 FAKE-0001 --twice`, add `--clock-offset-minutes=90 --live=4` for clock drift, and use `--backlog=20 --twice` for outage replay. Raw deliveries are retained byte-for-byte; parsed punches are unique by device, PIN, and device timestamp.

Video uploads use `POST /api/videos` with the raw video body and `Content-Type: video/*`. The upload and playback-link minting routes, as well as job administration routes, require `x-ops-token` matching `OPS_TOKEN`. A successful response contains a five-minute signed play URL. Set `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`; create the bucket before the first upload. The shared byte quota defaults to 500 MiB.

Jobs are enqueued with `POST /api/jobs` using `{ "kind": "...", "payload": {} }`. Register each job kind with `registerJob` in application code. Failures retry with 5, 10, 20, 40, and then 80 second backoffs (capped at one hour) until `JOB_MAX_ATTEMPTS`; terminal errors appear at `GET /api/jobs/failed` and can be replayed at `POST /api/jobs/failed/:id/replay`.

Run `npm test` and `npm run test:isolation` before deployment. The latter includes explicit checks for the global operational tables and ops-token authorization. `scripts/protect-main.sh Majidsiddque/CRM` must be run by a GitHub administrator to make the `build` status a merge requirement; a workflow step by itself does not configure GitHub branch protection.

See `EXPERIMENT_RESULTS.md` for verified local and external status, and `REGISTRATIONS_TRACKER.csv` for account follow-ups.
