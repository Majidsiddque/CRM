output "health_check_url" {
  value       = "http://${aws_lb.backend.dns_name}/health"
  description = "Should answer {\"status\":\"running\"}."
}

output "github_deploy_role_arn" {
  value       = aws_iam_role.github_deploy.arn
  description = "Save as the GitHub repository variable AWS_ROLE_ARN."
}

output "region" {
  value = var.region
}

output "ecr_repository" {
  value = aws_ecr_repository.backend.name
}
