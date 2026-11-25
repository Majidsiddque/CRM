variable "region" {
  type        = string
  default     = "ap-south-1" # Mumbai
  description = "AWS region."
}

variable "name" {
  type        = string
  default     = "crm-staging"
  description = "Prefix for every resource."
}

variable "github_repo" {
  type        = string
  description = "GitHub repository allowed to deploy, as owner/name, e.g. acme/CRM."
}

variable "create_github_oidc_provider" {
  type        = bool
  default     = true
  description = "Set false if this AWS account already has the token.actions.githubusercontent.com OIDC provider."
}

variable "budget_emails" {
  type        = list(string)
  description = "Who gets budget alert emails."
}

variable "monthly_budget_usd" {
  type        = number
  default     = 30
  description = "Monthly cost limit for the whole account/staging in USD."
}

variable "desired_count" {
  type        = number
  default     = 1
  description = "Number of backend containers. Set 0 to pause staging and stop its cost."
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}
