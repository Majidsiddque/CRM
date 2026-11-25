terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  # For a team, move state to S3 (see README). Local state is fine for day one.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = var.name
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}
