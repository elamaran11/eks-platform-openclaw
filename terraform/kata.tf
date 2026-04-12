# kata.tf — SG tag for Karpenter discovery only.
# EC2NodeClass moved to karpenter.tf (self-managed Karpenter).

# Tag the cluster security group so self-managed Karpenter EC2NodeClass can discover it
resource "aws_ec2_tag" "kata_sg_karpenter_discovery" {
  resource_id = module.eks.cluster_primary_security_group_id
  key         = "karpenter.sh/discovery"
  value       = local.cluster_name
}

# Tag private subnets for self-managed Karpenter subnet discovery
resource "aws_ec2_tag" "kata_subnet_karpenter_discovery" {
  for_each    = toset(module.vpc.private_subnets)
  resource_id = each.value
  key         = "karpenter.sh/discovery"
  value       = local.cluster_name
}
