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

# ── EC2NodeClass (AL2023 + kata userData) ─────────────────────────────────────

resource "kubectl_manifest" "kata_ec2nodeclass" {
  count = var.enable_kata_nodes ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: karpenter.k8s.aws/v1
    kind: EC2NodeClass
    metadata:
      name: kata-bare-metal
    spec:
      role: "${aws_iam_role.karpenter_node.name}"
      subnetSelectorTerms:
        - tags:
            karpenter.sh/discovery: "${local.cluster_name}"
      securityGroupSelectorTerms:
        - tags:
            karpenter.sh/discovery: "${local.cluster_name}"
      amiSelectorTerms:
        - alias: al2023@latest
      blockDeviceMappings:
        - deviceName: /dev/xvda
          ebs:
            volumeSize: 200Gi
            volumeType: gp3
            iops: 3000
            throughput: 125
            deleteOnTermination: true
      userData: |
        #!/bin/bash
        set -euo pipefail

        dnf install -y lvm2 kata-containers

        NVME_DEVICES=$(lsblk -dpno NAME,TYPE | awk '$2=="disk" && $1~/nvme/ {print $1}' | sort)
        DEVICE_COUNT=$(echo "$NVME_DEVICES" | wc -l)

        if [ "$DEVICE_COUNT" -gt 1 ]; then
          dnf install -y mdadm
          mdadm --create /dev/md0 --level=0 --raid-devices="$DEVICE_COUNT" $NVME_DEVICES
          BLOCK_DEVICE=/dev/md0
        else
          BLOCK_DEVICE=$(echo "$NVME_DEVICES" | head -1)
        fi

        pvcreate "$BLOCK_DEVICE"
        vgcreate containerd-vg "$BLOCK_DEVICE"
        lvcreate --wipesignatures y -n thinpool containerd-vg -l 95%VG
        lvcreate --wipesignatures y -n thinpoolmeta containerd-vg -l 1%VG
        lvconvert -y --zero n -c 512K \
          --thinpool containerd-vg/thinpool \
          --poolmetadata containerd-vg/thinpoolmeta

        cat > /etc/lvm/profile/containerd-vg-thinpool.profile <<'LVMEOF'
        activation {
          thin_pool_autoextend_threshold=80
          thin_pool_autoextend_percent=20
        }
        LVMEOF
        lvchange --metadataprofile containerd-vg-thinpool containerd-vg/thinpool

        mkdir -p /etc/containerd/conf.d
        cat > /etc/containerd/conf.d/kata.toml <<'CTREOF'
        [plugins."io.containerd.grpc.v1.cri".containerd]
          snapshotter = "devmapper"

        [plugins."io.containerd.snapshotter.v1.devmapper"]
          pool_name = "containerd-vg-thinpool"
          root_path = "/var/lib/containerd/io.containerd.snapshotter.v1.devmapper"
          base_image_size = "10GB"
          discard_blocks = true

        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu.options]
            ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"
        CTREOF

        systemctl restart containerd
  YAML

  depends_on = [
    module.eks,
    aws_iam_role.karpenter_node,
    aws_eks_access_entry.karpenter_node,
    aws_eks_pod_identity_association.karpenter_controller,
  ]
}

# ── ArgoCD Application for Karpenter (injected via Terraform for cluster endpoint) ──

resource "kubectl_manifest" "argocd_karpenter" {
  yaml_body = <<-YAML
    apiVersion: argoproj.io/v1alpha1
    kind: Application
    metadata:
      name: karpenter
      namespace: argocd
      annotations:
        argocd.argoproj.io/sync-wave: "-1"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        chart: karpenter
        repoURL: oci://public.ecr.aws/karpenter
        targetRevision: 0.37.7
        helm:
          valuesObject:
            serviceAccount:
              name: karpenter
            settings:
              clusterName: "${module.eks.cluster_name}"
              clusterEndpoint: "${module.eks.cluster_endpoint}"
              interruptionQueue: "${aws_sqs_queue.karpenter_interruption.name}"
            tolerations:
              - key: CriticalAddonsOnly
                operator: Exists
            affinity:
              nodeAffinity:
                requiredDuringSchedulingIgnoredDuringExecution:
                  nodeSelectorTerms:
                    - matchExpressions:
                        - key: eks.amazonaws.com/compute-type
                          operator: In
                          values: ["auto"]
            controller:
              resources:
                requests:
                  cpu: 250m
                  memory: 512Mi
                limits:
                  cpu: "1"
                  memory: 1Gi
      destination:
        server: https://kubernetes.default.svc
        namespace: karpenter
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
  YAML

  depends_on = [
    module.eks_blueprints_addons,
    aws_eks_pod_identity_association.karpenter_controller,
    aws_sqs_queue.karpenter_interruption,
  ]
}
