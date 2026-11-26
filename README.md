# CRM Backend

A production-ready multi-tenant CRM backend with secure payment processing, built with Express, PostgreSQL, and row-level security.

[![CI](https://github.com/Majidsiddque/CRM/actions/workflows/ci.yml/badge.svg)](https://github.com/Majidsiddque/CRM/actions/workflows/ci.yml)

## Features

- **Multi-tenant architecture** with PostgreSQL Row-Level Security (RLS)
- **Secure payment processing** via Razorpay with webhook verification
- **Complete test coverage** (70 tests: 20 application + 50 isolation tests)
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

4. **Reset database** (wipes all data):
   ```bash
   npm run dev:reset
   ```

### Testing

```bash
# Run all tests
npm test

# Run isolation tests (RLS enforcement)
npm run test:isolation

# Type checking
npm run typecheck

# Linting
npm run lint

# Build
npm run build
```

## API Endpoints

### Health Check
```
GET /health
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
- 50 automated tests verify isolation across all attack vectors
- Attempts to read, modify, or delete another institute's data are blocked
- Database user is restricted (non-superuser, cannot bypass RLS)

**Test Institute ID**: `11111111-1111-1111-1111-111111111111`

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
- Executes all 70 tests (including RLS isolation)
- Builds Docker image
- Deploys to staging (on main branch)

**Required GitHub Repository Variables**:
- `AWS_ROLE_ARN`: IAM role for GitHub Actions deployment
- `AWS_REGION`: `ap-southeast-2` (optional, defaults to ap-south-1)

## Project Structure

```
├── src/
│   ├── app.ts           # Express app with routes
│   ├── index.ts         # Server entry point
│   └── razorpay.ts      # Payment integration
├── db/
│   ├── schema.sql       # Database schema with RLS
│   └── seed.sql         # Test data (2 institutes, 2000 people)
├── tests/
│   ├── api.test.ts      # Application tests
│   ├── razorpay.test.ts # Payment tests
│   └── isolation.test.ts # RLS security tests
├── infra/staging/       # Terraform AWS infrastructure
├── .github/workflows/   # CI/CD pipeline
└── scripts/             # Utility scripts

```

## Development Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with Docker Postgres |
| `npm run dev:reset` | Wipe database and restart |
| `npm test` | Run application tests |
| `npm run test:isolation` | Run RLS security tests |
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
4. Submit pull request

## License

MIT

## Support

For issues and questions, please open a GitHub issue.
