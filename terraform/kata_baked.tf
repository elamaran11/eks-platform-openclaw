# kata_baked.tf — Wave 2 additive MNG using Packer-baked AMI + nodeadm
#
# ADDITIVE-ONLY: this file creates a NEW managed node group alongside the
# existing kata MNG in kata.tf. The existing MNG, the kata-deploy DaemonSet,
# and all workloads currently running on kata-qemu stay untouched.
#
# Distinct label + taint isolate the new pool:
#   label: kata-path=baked-ami
#   taint: kata-baked=true:NO_SCHEDULE
# Existing pods with `runtimeClassName: kata-qemu` + toleration for `kata`
# will NOT schedule here — they stay on the old MNG.
#
# To actually use this node, a pod must set:
#   nodeSelector:
#     kata-path: baked-ami
#   tolerations:
#     - key: kata-baked
#       operator: Equal
#       value: "true"
#       effect: NoSchedule
#
# This is deliberate: Wave 2 proves the baked path works in isolation.
# Wave 3 (later, explicit decision) migrates real workloads.

# ------------------------------------------------------------------------
# Baked AMI ID — published by Packer pipeline to SSM
# ------------------------------------------------------------------------
data "aws_ssm_parameter" "kata_ami_id" {
  name = "/openclaw/kata/ami-id"
}

# ------------------------------------------------------------------------
# Launch template — baked AMI + nodeadm NodeConfig
#
# The MIME-multipart userData contains a NodeConfig document that:
#   1. spec.cluster.{...} — cluster join info (required when ami_type=CUSTOM)
#   2. spec.containerd.config — registers kata-clh + kata-qemu runtime
#      handlers in containerd BEFORE it starts for the first time.
#      No post-boot containerd restart. No kubelet-restart DaemonSet.
# ------------------------------------------------------------------------
resource "aws_launch_template" "kata_baked" {
  count = var.enable_kata_baked ? 1 : 0

  name        = "${local.cluster_name}-kata-baked"
  description = "Kata bare-metal node from Packer-baked AMI (CLH default)"

  image_id = data.aws_ssm_parameter.kata_ami_id.value

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      # Must be >= the Packer builder's EBS size (250GB) — EBS can't shrink
      # from a snapshot. If you rebuild the AMI with a smaller builder disk,
      # you can lower this.
      volume_size           = 250
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  # userData — cluster-join info ONLY. Containerd runtime handlers are baked
  # into /etc/eks/nodeadm.d/50-kata-containerd.yaml by the Packer script.
  # The EKS-optimized AL2023 AMI's nodeadm-config systemd service merges
  # userData with any drop-ins in /etc/eks/nodeadm.d/ before nodeadm-run
  # (per AWS docs: eks/latest/userguide/al2023.html — "Additional Information
  # About nodeadm").
  #
  # Previous userData also contained a containerd.config block; combining
  # it with the baked drop-in triggered a double-nodeadm-init race that
  # misconfigured the ENA driver and rebooted the node. Keeping this
  # userData minimal (cluster-only) is required.
  user_data = base64encode(<<-EOT
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="BOUNDARY"

    --BOUNDARY
    Content-Type: application/node.eks.aws

    ---
    apiVersion: node.eks.aws/v1alpha1
    kind: NodeConfig
    spec:
      cluster:
        name: ${module.eks.cluster_name}
        apiServerEndpoint: ${module.eks.cluster_endpoint}
        certificateAuthority: ${module.eks.cluster_certificate_authority_data}
        cidr: ${module.eks.cluster_service_cidr}

    --BOUNDARY--
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.tags, {
      Name     = "${local.cluster_name}-kata-baked-node"
      KataPath = "baked-ami"
    })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = local.tags
  }

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-kata-baked"
  })
}

# ------------------------------------------------------------------------
# Managed Node Group — custom AMI path
#
# Reuses aws_iam_role.kata_node + aws_eks_access_entry.kata_node from
# kata.tf (same IAM needs; no point duplicating).
# ------------------------------------------------------------------------
resource "aws_eks_node_group" "kata_baked" {
  count = var.enable_kata_baked ? 1 : 0

  cluster_name    = module.eks.cluster_name
  node_group_name = "${local.cluster_name}-kata-baked"
  node_role_arn   = aws_iam_role.kata_node.arn

  subnet_ids = module.vpc.private_subnets

  # CUSTOM required when launch_template carries an image_id
  ami_type = "CUSTOM"

  scaling_config {
    desired_size = 1
    max_size     = 2
    min_size     = 0
  }

  instance_types = var.kata_instance_types

  launch_template {
    id      = aws_launch_template.kata_baked[0].id
    version = aws_launch_template.kata_baked[0].latest_version
  }

  # Labels
  # - `katacontainers.io/kata-runtime=true` REQUIRED so the existing aws-node
  #   (VPC CNI) DaemonSet schedules here. Without CNI the node can't become
  #   Ready and EKS times the MNG out. aws-node is pinned to this label in
  #   gitops/helm/aws-node/templates/aws-node.yaml.
  # - `kata-path=baked-ami` marks this pool distinct from the kata-deploy pool
  #   for any workload that wants to explicitly target it.
  labels = {
    "katacontainers.io/kata-runtime" = "true"
    "kata-path"                      = "baked-ami"
  }

  # DISTINCT taint — isolates the node from workloads tolerating `kata`.
  # Existing finance-assistant + slack-sandbox tolerate `kata=true:NoSchedule`,
  # NOT `kata-baked=true:NoSchedule`, so they will not schedule here.
  # kata-deploy DaemonSet tolerates `kata` only → will NOT land here either.
  taint {
    key    = "kata-baked"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  update_config {
    max_unavailable_percentage = 50
  }

  tags = merge(local.tags, {
    KataPath = "baked-ami"
  })

  depends_on = [
    module.eks,
    aws_iam_role_policy_attachment.kata_node_worker,
    aws_iam_role_policy_attachment.kata_node_ecr,
    aws_iam_role_policy_attachment.kata_node_cni,
    aws_eks_access_entry.kata_node,
    aws_launch_template.kata_baked,
  ]
}

# ------------------------------------------------------------------------
# Outputs for verification / future GitOps wiring
# ------------------------------------------------------------------------
output "kata_baked_node_group_name" {
  description = "New MNG name using the baked AMI (empty if disabled)"
  value       = try(aws_eks_node_group.kata_baked[0].node_group_name, "")
}

output "kata_baked_launch_template_id" {
  description = "Launch template ID (empty if disabled)"
  value       = try(aws_launch_template.kata_baked[0].id, "")
}

output "kata_baked_ami_id" {
  description = "Baked Kata AMI ID (from SSM)"
  value       = data.aws_ssm_parameter.kata_ami_id.value
  sensitive   = true
}
