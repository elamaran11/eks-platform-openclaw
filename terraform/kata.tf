# kata.tf — EKS Managed Node Group for Kata bare-metal nodes
# Using managed node group so nodes get aws-node, kube-proxy, ebs-csi automatically.
# kata-deploy DaemonSet (via GitOps) installs the kata-qemu runtime on these nodes.
# No custom launch template needed — kata-deploy handles containerd configuration.

resource "aws_eks_node_group" "kata" {
  count = var.enable_kata_nodes ? 1 : 0

  cluster_name    = module.eks.cluster_name
  node_group_name = "${local.cluster_name}-kata"
  node_role_arn   = module.eks.node_iam_role_arn

  subnet_ids = module.vpc.private_subnets

  ami_type = "AL2023_x86_64_STANDARD"

  scaling_config {
    desired_size = 1
    max_size     = 3
    min_size     = 0
  }

  instance_types = var.kata_instance_types

  labels = {
    "katacontainers.io/kata-runtime" = "true"
  }

  taint {
    key    = "kata"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  tags = local.tags

  depends_on = [module.eks]
}
