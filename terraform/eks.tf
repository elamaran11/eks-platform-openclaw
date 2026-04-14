module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = local.cluster_name
  cluster_version = var.cluster_version

  cluster_endpoint_public_access = var.cluster_endpoint_public_access

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.private_subnets

  # EKS Auto Mode — manages Karpenter, VPC CNI, EBS CSI, CoreDNS, LB controller
  cluster_compute_config = {
    enabled    = true
    node_pools = ["general-purpose", "system"]
  }

  # EKS managed addons — for self-managed Karpenter kata nodes
  # Note: aws-node (VPC CNI) is not available as addon with Auto Mode — managed internally
  cluster_addons = {
    kube-proxy = {
      most_recent                 = true
      resolve_conflicts_on_create = "OVERWRITE"
      resolve_conflicts_on_update = "OVERWRITE"
    }
    coredns = {
      most_recent                 = true
      resolve_conflicts_on_create = "OVERWRITE"
      resolve_conflicts_on_update = "OVERWRITE"
    }
    aws-ebs-csi-driver = {
      most_recent                 = true
      resolve_conflicts_on_create = "OVERWRITE"
      resolve_conflicts_on_update = "OVERWRITE"
      service_account_role_arn    = aws_iam_role.ebs_csi.arn
    }
  }

  # Use EKS Access Entries API (GA 2024) — auditable via CloudTrail, no aws-auth ConfigMap
  authentication_mode                      = "API"
  enable_cluster_creator_admin_permissions = true

  access_entries = {}

  tags = local.tags
}
