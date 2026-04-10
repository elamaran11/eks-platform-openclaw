module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = local.cluster_name
  cluster_version = var.cluster_version

  cluster_endpoint_public_access = var.cluster_endpoint_public_access

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.intra_subnets

  # EKS Auto Mode — manages Karpenter, VPC CNI, EBS CSI, CoreDNS, LB controller
  cluster_compute_config = {
    enabled    = true
    node_pools = ["general-purpose", "system"]
  }

  # Use EKS Access Entries API (GA 2024) — auditable via CloudTrail, no aws-auth ConfigMap
  authentication_mode                      = "API"
  enable_cluster_creator_admin_permissions = true

  # Additional IAM principals granted cluster-admin via access entries
  access_entries = {
    for arn in var.admin_role_arns : arn => {
      principal_arn = arn
      policy_associations = {
        admin = {
          policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster" }
        }
      }
    }
  }

  tags = local.tags
}
