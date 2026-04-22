# karpenter.tf — Karpenter controller IAM, SQS interruption queue, Pod Identity
#
# DRAFT — not yet applied. This file is additive: it creates new AWS resources
# (IAM role, SQS queue, EventBridge rules, Pod Identity association) and does
# not modify any existing resource.
#
# After terraform apply:
#   - Karpenter controller can be installed via GitOps (gitops/helm/karpenter)
#   - NodePools + EC2NodeClass referenced by apps/kata-baked.yaml will work
#
# The existing kata MNG (aws_eks_node_group.kata) and kata-deploy DaemonSet
# are NOT touched by anything here.

module "karpenter" {
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~> 20.0"

  cluster_name = module.eks.cluster_name

  # Pod Identity (preferred over IRSA on v20)
  enable_pod_identity             = true
  create_pod_identity_association = true
  namespace                       = "kube-system"
  service_account                 = "karpenter"

  # Node IAM role — Karpenter-launched nodes assume this
  node_iam_role_use_name_prefix   = false
  node_iam_role_name              = "${local.cluster_name}-karpenter-node"
  node_iam_role_attach_cni_policy = true

  # Access entry so Karpenter-launched nodes are recognized by EKS
  create_access_entry = true

  tags = local.tags
}

# Read the AMI ID published by the Packer pipeline.
# Empty string during Wave 0 (SSM param created with placeholder);
# real AMI ID populated after the first Packer build (Wave 1).
data "aws_ssm_parameter" "kata_ami_id" {
  name = "/openclaw/kata/ami-id"
}

# Discovery tags — EC2NodeClass selectors look for these on subnets/security groups
resource "aws_ec2_tag" "karpenter_subnet_discovery" {
  for_each    = toset(module.vpc.private_subnets)
  resource_id = each.value
  key         = "karpenter.sh/discovery"
  value       = local.cluster_name
}

resource "aws_ec2_tag" "karpenter_sg_discovery" {
  resource_id = module.eks.node_security_group_id
  key         = "karpenter.sh/discovery"
  value       = local.cluster_name
}

# Outputs consumed by GitOps chart values and by the EC2NodeClass (via Helm).
output "karpenter_queue_name" {
  description = "SQS queue Karpenter polls for spot interruption + EC2 health events"
  value       = module.karpenter.queue_name
}

output "karpenter_node_iam_role_name" {
  description = "IAM role Karpenter-launched nodes assume (referenced by EC2NodeClass.role)"
  value       = module.karpenter.node_iam_role_name
}

output "karpenter_service_account" {
  description = "ServiceAccount the Karpenter controller uses (bound via Pod Identity)"
  value       = "karpenter"
}

output "kata_ami_id" {
  description = "Baked Kata AMI ID (published by Packer pipeline into SSM)"
  value       = data.aws_ssm_parameter.kata_ami_id.value
  # SSM parameter values are sensitive by default; AMI ID is not secret but the
  # type coerces the marker up the chain. Explicit marker required by Terraform.
  sensitive = true
}
