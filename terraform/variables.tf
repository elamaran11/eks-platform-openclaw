variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-west-2"
}

variable "bedrock_region" {
  description = "AWS region for Bedrock inference (use cross-region inference profile region)"
  type        = string
  default     = "us-west-2"
}

variable "project_name" {
  description = "Project name used as prefix for all resources"
  type        = string
  default     = "openclaw"
}

variable "cluster_version" {
  description = "Kubernetes version for the EKS cluster"
  type        = string
  default     = "1.32"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "enable_kata_nodes" {
  description = "Whether to deploy bare-metal Kata container node pool"
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access" {
  description = "Whether the EKS cluster API endpoint is publicly accessible"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "admin_role_arns" {
  description = "IAM role ARNs granted cluster-admin via EKS access entries (auditable via CloudTrail)"
  type        = list(string)
  default     = []
}

variable "gitops_repo_url" {
  description = "Git repository URL ArgoCD watches for app-of-apps (e.g. https://github.com/org/openclaw-eks-automode)"
  type        = string
}

variable "gitops_target_revision" {
  description = "Git branch/tag ArgoCD tracks"
  type        = string
  default     = "HEAD"
}
