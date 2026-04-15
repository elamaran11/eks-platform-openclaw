# kata.tf — EKS Managed Node Group for Kata bare-metal nodes
# Using managed node group so nodes get aws-node, kube-proxy, ebs-csi automatically.
# kata-deploy DaemonSet (via GitOps) installs the kata-qemu runtime on these nodes.

# Dedicated IAM role for kata nodes — Auto Mode node role has insufficient permissions
resource "aws_iam_role" "kata_node" {
  name = "${local.cluster_name}-kata-node"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "kata_node_worker" {
  role       = aws_iam_role.kata_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "kata_node_ecr" {
  role       = aws_iam_role.kata_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "kata_node_cni" {
  role       = aws_iam_role.kata_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "kata_node_ssm" {
  role       = aws_iam_role.kata_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# EKS access entry for kata node role
resource "aws_eks_access_entry" "kata_node" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.kata_node.arn
  type          = "EC2_LINUX"
  tags          = local.tags
}

resource "aws_eks_node_group" "kata" {
  count = var.enable_kata_nodes ? 1 : 0

  cluster_name    = module.eks.cluster_name
  node_group_name = "${local.cluster_name}-kata"
  node_role_arn   = aws_iam_role.kata_node.arn

  subnet_ids = module.vpc.private_subnets

  ami_type = "AL2023_x86_64_STANDARD"

  scaling_config {
    desired_size = 1
    max_size     = 3
    min_size     = 0
  }

  instance_types = var.kata_instance_types

  disk_size = 100

  labels = {
    "katacontainers.io/kata-runtime" = "true"
  }

  taint {
    key    = "kata"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  tags = local.tags

  depends_on = [
    module.eks,
    aws_iam_role_policy_attachment.kata_node_worker,
    aws_iam_role_policy_attachment.kata_node_ecr,
    aws_iam_role_policy_attachment.kata_node_cni,
    aws_eks_access_entry.kata_node,
  ]
}

# Patch kube-proxy DaemonSet to also run on kata managed node group nodes.
# By default the kube-proxy addon only targets eks.amazonaws.com/compute-type=auto
# (EKS Auto Mode nodes). Kata nodes are a non-auto-mode managed node group and
# need kube-proxy so that kata-deploy can reach the Kubernetes API during install.
resource "null_resource" "kube_proxy_kata_affinity" {
  count = var.enable_kata_nodes ? 1 : 0

  triggers = {
    cluster_name = module.eks.cluster_name
    node_group   = aws_eks_node_group.kata[0].node_group_name
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region}
      kubectl patch daemonset kube-proxy -n kube-system --type=json -p='[
        {"op":"replace","path":"/spec/template/spec/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms","value":[
          {"matchExpressions":[
            {"key":"eks.amazonaws.com/compute-type","operator":"In","values":["auto"]},
            {"key":"kubernetes.io/arch","operator":"In","values":["amd64","arm64"]}
          ]},
          {"matchExpressions":[
            {"key":"eks.amazonaws.com/nodegroup","operator":"Exists"},
            {"key":"kubernetes.io/arch","operator":"In","values":["amd64","arm64"]}
          ]}
        ]}
      ]'
    EOT
  }

  depends_on = [
    aws_eks_node_group.kata,
    module.eks,
  ]
}
