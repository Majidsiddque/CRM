# Staging (AWS, Mumbai `ap-south-1`)

What it creates: ECR image registry, ECS Fargate service (1 small container), application load balancer whose
health check is `GET /health`, CloudWatch logs (14 days), a GitHub-only deploy role (no stored AWS keys),
and **budget alerts** (emails at 50 / 80 / 100 % of actual spend and when 100 % is *forecast*).
No database yet: the empty backend's `/health` does not need one.

## One-time setup

```bash
cd infra/staging
cp terraform.tfvars.example terraform.tfvars     # edit github_repo + budget_emails
terraform init
terraform apply
```

Then in GitHub → Settings → Secrets and variables → Actions → **Variables**, add:

* `AWS_ROLE_ARN` = output `github_deploy_role_arn`
* `AWS_REGION` = `ap-south-1` (optional, this is the default)

Push to `main`. The pipeline builds, tests, pushes the image, deploys, waits for a stable service and curls
`http://<alb>/health`, which must answer `{"status":"running"}`. The URL is the `health_check_url` output.
Confirm the budget emails by clicking nothing – AWS Budgets emails need no confirmation, but check spam.

## Cost notes

Roughly: ALB ≈ $18–20/month + Fargate 0.25 vCPU ≈ $9/month + small logs/ECR → about $30/month running
24×7. The default budget is $30 – change `monthly_budget_usd`. Pause staging with `desired_count = 0`
(the load balancer still bills). `terraform destroy` removes everything.

## Notes

* HTTP only (no domain/certificate yet). Add an ACM certificate + 443 listener when a domain exists.
* The first deploy is the first time a real image exists; until then ECS shows failing tasks – expected.
* Move Terraform state to an S3 bucket before more than one person applies.
* If the AWS account already has a GitHub OIDC provider, set `create_github_oidc_provider = false`.
