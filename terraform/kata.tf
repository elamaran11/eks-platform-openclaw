# kata.tf — EKS Managed Node Group for Kata bare-metal nodes
# Using managed node group so nodes get aws-node, kube-proxy, ebs-csi automatically.
# kata-deploy DaemonSet (via GitOps) installs the kata-qemu runtime on these nodes.

# AL2023 AMI — kata-deploy handles runtime install, no custom userData needed
data "aws_ami" "kata_al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amazon-eks-node-al2023-x86_64-standard-${var.cluster_version}-*"]
  }
}

resource "aws_launch_template" "kata" {
  name_prefix = "${local.cluster_name}-kata-"
  image_id    = data.aws_ami.kata_al2023.id

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 200
      volume_type           = "gp3"
      iops                  = 3000
      throughput            = 125
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.tags, { Name = "${local.cluster_name}-kata" })
  }

  tags = local.tags
}

resource "aws_eks_node_group" "kata" {
  count = var.enable_kata_nodes ? 1 : 0

  cluster_name    = module.eks.cluster_name
  node_group_name = "${local.cluster_name}-kata"
  node_role_arn   = module.eks.node_iam_role_arn

  subnet_ids = module.vpc.private_subnets

  launch_template {
    id      = aws_launch_template.kata.id
    version = aws_launch_template.kata.latest_version
  }

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
