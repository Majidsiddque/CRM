# Security Hardening Checklist

## Production Deployment Requirements

### Database Security

#### 1. Change Default Password
The default `app_user` password is `change_me` in `db/schema.sql`. **This MUST be changed before production use.**

**Steps:**
1. Connect to your production database as a superuser
2. Run: `ALTER ROLE app_user PASSWORD 'your-secure-password-here';`
3. Update `DATABASE_URL` in your production environment to use the new password
4. For AWS ECS: Store the password in AWS Secrets Manager or Systems Manager Parameter Store
5. Update the ECS task definition to inject the secret as an environment variable

**Example for AWS Secrets Manager:**
```bash
# Create secret
aws secretsmanager create-secret \
  --name crm-staging/db-password \
  --secret-string "your-secure-password"

# Update task definition to reference it
# (see infra/staging/main.tf - add secrets configuration to container definition)
```

### Application Security

#### 2. Disable Development Endpoints
The `/api/attack` endpoint is now protected by NODE_ENV check and disabled in production.

**Verify:**
- Set `NODE_ENV=production` in your production environment
- Confirm `/api/attack` returns 404 or is not accessible

#### 3. Environment Variables
Ensure all sensitive environment variables are properly configured:

**Required for Production:**
```bash
NODE_ENV=production
DATABASE_URL=postgres://app_user:SECURE_PASSWORD@db-host:5432/dbname
RAZORPAY_KEY_ID=rzp_test_... (or rzp_live_... for production payments)
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
PORT=3000
```

**Never commit:**
- `.env` files
- `terraform.tfvars` with real values
- `terraform.tfstate` files
- Any files containing credentials

### Infrastructure Security

#### 4. AWS Security Best Practices
- ✅ Use GitHub OIDC (no stored AWS keys) - already configured
- ⚠️ Rotate database passwords regularly
- ⚠️ Enable AWS CloudTrail for audit logging
- ⚠️ Configure AWS GuardDuty for threat detection
- ⚠️ Set up AWS Config for compliance monitoring
- ⚠️ Use VPC with private subnets for database (if using RDS)

#### 5. Network Security
- ⚠️ Configure security groups to allow only necessary traffic
- ⚠️ Enable HTTPS with ACM certificate (currently HTTP only)
- ⚠️ Consider adding AWS WAF for web application firewall
- ⚠️ Set up VPC endpoints for AWS services to avoid internet traffic

### Razorpay Security

#### 6. Webhook Security
- ✅ Signature verification implemented (HMAC-SHA256)
- ✅ Timing-safe comparison to prevent timing attacks
- ✅ Test-mode enforcement (refuses live keys in code)
- ⚠️ Verify webhook URL uses HTTPS in production
- ⚠️ Rotate webhook secret regularly

### Monitoring & Alerts

#### 7. Set Up Monitoring
- ⚠️ Configure CloudWatch alarms for:
  - ECS task failures
  - High CPU/memory usage
  - Application errors (5xx responses)
  - Database connection failures
- ⚠️ Set up AWS Budget alerts (configured in terraform)
- ⚠️ Enable AWS X-Ray for distributed tracing
- ⚠️ Configure log aggregation and analysis

### Data Protection

#### 8. Backup & Recovery
- ⚠️ Set up automated database backups
- ⚠️ Test backup restoration procedure
- ⚠️ Document recovery time objectives (RTO) and recovery point objectives (RPO)
- ⚠️ Store backups in a separate region

#### 9. Data Privacy
- ⚠️ Review data retention policies
- ⚠️ Implement data deletion procedures
- ⚠️ Ensure compliance with GDPR/privacy regulations
- ⚠️ Document what data is collected and why

### Access Control

#### 10. IAM & Authentication
- ✅ GitHub OIDC for deployments (no long-lived credentials)
- ⚠️ Implement principle of least privilege for all IAM roles
- ⚠️ Enable MFA for AWS console access
- ⚠️ Regular access audits
- ⚠️ Remove unused IAM users/roles

## Security Checklist Summary

- [ ] Change database password from 'change_me'
- [ ] Set NODE_ENV=production in production environment
- [ ] Store secrets in AWS Secrets Manager/Parameter Store
- [ ] Enable HTTPS with ACM certificate
- [ ] Configure CloudWatch alarms
- [ ] Verify budget alerts are working
- [ ] Set up automated backups
- [ ] Review and restrict security groups
- [ ] Enable CloudTrail and GuardDuty
- [ ] Document incident response procedures
- [ ] Regular security audits

## Reporting Security Issues

If you discover a security vulnerability, please email [CONTACT_EMAIL_HERE] instead of using the issue tracker.

## Security Updates

This document should be reviewed and updated:
- After any infrastructure changes
- After any security incident
- At least quarterly
- When AWS or application dependencies are updated

Last updated: [CURRENT_DATE]
