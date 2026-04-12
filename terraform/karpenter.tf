# Self-managed Karpenter for Kata bare-metal nodes (AL2023)
# Coexists with EKS Auto Mode — scoped to kata-bare-metal NodePool only via EC2NodeClass

# ── Node IAM Role ──────────────────────────────────────────────────────────────

resource "aws_iam_role" "karpenter_node" {
  name = "${local.cluster_name}-karpenter-node"

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

resource "aws_iam_role_policy_attachment" "karpenter_node_worker" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "karpenter_node_ecr" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "karpenter_node_ssm" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "karpenter_node" {
  name = "${local.cluster_name}-karpenter-node"
  role = aws_iam_role.karpenter_node.name
  tags = local.tags
}

# EKS access entry — EC2_LINUX type auto-grants system:nodes group
resource "aws_eks_access_entry" "karpenter_node" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.karpenter_node.arn
  type          = "EC2_LINUX"
  tags          = local.tags
}

# ── Controller IAM Role (Pod Identity) ────────────────────────────────────────

resource "aws_iam_role" "karpenter_controller" {
  name = "${local.cluster_name}-karpenter-controller"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "karpenter_controller" {
  name = "karpenter-controller"
  role = aws_iam_role.karpenter_controller.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEC2"
        Effect = "Allow"
        Action = [
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeImages",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceTypeOfferings",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSpotPriceHistory",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:CreateFleet",
          "ec2:CreateLaunchTemplate",
          "ec2:CreateTags",
          "ec2:DeleteLaunchTemplate",
          "ec2:RunInstances",
          "ec2:TerminateInstances"
        ]
        Resource = "*"
      },
      {
        Sid      = "AllowIAMPassRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.karpenter_node.arn
      },
      {
        Sid    = "AllowIAMInstanceProfile"
        Effect = "Allow"
        Action = [
          "iam:AddRoleToInstanceProfile",
          "iam:CreateInstanceProfile",
          "iam:DeleteInstanceProfile",
          "iam:GetInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile",
          "iam:TagInstanceProfile"
        ]
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/*"
      },
      {
        Sid    = "AllowSQS"
        Effect = "Allow"
        Action = [
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ReceiveMessage"
        ]
        Resource = aws_sqs_queue.karpenter_interruption.arn
      },
      {
        Sid      = "AllowSSM"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:aws:ssm:${var.region}::parameter/aws/service/*"
      },
      {
        Sid      = "AllowPricing"
        Effect   = "Allow"
        Action   = "pricing:GetProducts"
        Resource = "*"
      }
    ]
  })
}

resource "aws_eks_pod_identity_association" "karpenter_controller" {
  cluster_name    = module.eks.cluster_name
  namespace       = "karpenter"
  service_account = "karpenter"
  role_arn        = aws_iam_role.karpenter_controller.arn
  tags            = local.tags
}

# ── SQS Interruption Queue ─────────────────────────────────────────────────────

resource "aws_sqs_queue" "karpenter_interruption" {
  name                      = "${local.cluster_name}-karpenter"
  message_retention_seconds = 300
  sqs_managed_sse_enabled   = true
  tags                      = local.tags
}

resource "aws_sqs_queue_policy" "karpenter_interruption" {
  queue_url = aws_sqs_queue.karpenter_interruption.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "sqs.amazonaws.com"] }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.karpenter_interruption.arn
    }]
  })
}

# ── EventBridge Interruption Rules ────────────────────────────────────────────

locals {
  karpenter_interruption_rules = {
    spot_interruption     = { source = ["aws.ec2"],    detail_type = ["EC2 Spot Instance Interruption Warning"] }
    rebalance             = { source = ["aws.ec2"],    detail_type = ["EC2 Instance Rebalance Recommendation"] }
    scheduled_change      = { source = ["aws.health"], detail_type = ["AWS Health Event"] }
    instance_state_change = { source = ["aws.ec2"],    detail_type = ["EC2 Instance State-change Notification"] }
  }
}

resource "aws_cloudwatch_event_rule" "karpenter_interruption" {
  for_each = local.karpenter_interruption_rules

  name = "${local.cluster_name}-karpenter-${each.key}"
  event_pattern = jsonencode({
    source      = each.value.source
    detail-type = each.value.detail_type
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "karpenter_interruption" {
  for_each = local.karpenter_interruption_rules

  rule      = aws_cloudwatch_event_rule.karpenter_interruption[each.key].name
  target_id = "KarpenterInterruptionQueueTarget"
  arn       = aws_sqs_queue.karpenter_interruption.arn
}

# ── Karpenter Helm Release (via Terraform — needs cluster endpoint injection) ──

resource "helm_release" "karpenter" {
  name             = "karpenter"
  repository       = "oci://public.ecr.aws/karpenter"
  chart            = "karpenter"
  version          = "0.37.7"
  namespace        = "karpenter"
  create_namespace = true

  set {
    name  = "serviceAccount.name"
    value = "karpenter"
  }

  set {
    name  = "settings.clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "settings.clusterEndpoint"
    value = module.eks.cluster_endpoint
  }

  set {
    name  = "settings.interruptionQueue"
    value = aws_sqs_queue.karpenter_interruption.name
  }

  set {
    name  = "tolerations[0].key"
    value = "CriticalAddonsOnly"
  }

  set {
    name  = "tolerations[0].operator"
    value = "Exists"
  }

  set {
    name  = "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key"
    value = "eks.amazonaws.com/compute-type"
  }

  set {
    name  = "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator"
    value = "In"
  }

  set {
    name  = "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]"
    value = "auto"
  }

  depends_on = [
    module.eks_blueprints_addons,
    aws_eks_pod_identity_association.karpenter_controller,
    aws_sqs_queue.karpenter_interruption,
    aws_eks_access_entry.karpenter_node,
  ]
}
