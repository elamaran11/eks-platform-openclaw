# NodeClass stays in Terraform — it needs module.eks.node_iam_role_name at apply time.
# NodePool and RuntimeClass are in gitops/helm/kata/ (managed by ArgoCD).

# Tag the cluster security group so Karpenter NodeClass can discover it
resource "aws_ec2_tag" "kata_sg_karpenter_discovery" {
  resource_id = module.eks.cluster_primary_security_group_id
  key         = "karpenter.sh/discovery"
  value       = local.cluster_name
}

resource "kubectl_manifest" "kata_nodeclass" {
  count = var.enable_kata_nodes ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: eks.amazonaws.com/v1
    kind: NodeClass
    metadata:
      name: kata-bare-metal
    spec:
      role: "${module.eks.node_iam_role_name}"
      subnetSelectorTerms:
        - tags:
            karpenter.sh/discovery: "${local.cluster_name}"
      securityGroupSelectorTerms:
        - tags:
            karpenter.sh/discovery: "${local.cluster_name}"
      amiSelectorTerms:
        - alias: bottlerocket@latest
      ephemeralStorage:
        size: "200Gi"
        iops: 3000
        throughput: 125
  YAML

  depends_on = [module.eks]
}
