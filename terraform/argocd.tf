# ArgoCD via EKS Blueprints Addons — AWS-maintained bootstrap pattern
# aws_eks_capability is not yet available in the Terraform AWS provider

module "eks_blueprints_addons" {
  source = "aws-ia/eks-blueprints-addons/aws"
  # Pin to the last 1.x line that requires helm ~> 2.x. v1.24.0 bumped its helm
  # provider requirement to ">= 3.0", which conflicts with this stack's
  # helm "~> 2.0" pin (versions.tf) and the locked provider (helm 2.17.0),
  # producing an unsatisfiable "~> 2.0, >= 3.0.0" during `terraform init -upgrade`.
  version = "~> 1.23.0"

  cluster_name      = module.eks.cluster_name
  cluster_endpoint  = module.eks.cluster_endpoint
  cluster_version   = module.eks.cluster_version
  oidc_provider_arn = module.eks.oidc_provider_arn

  enable_argocd = true
  argocd = {
    namespace     = "argocd"
    chart_version = "7.8.0"
  }

  # Self-managed AWS Load Balancer Controller — provisions ALBs/NLBs from
  # Ingress (class "alb") + Service type LoadBalancer. The module creates the
  # IRSA role + IAM policy and installs the Helm chart. Backs the "alb"
  # IngressClass (controller ingress.k8s.aws/alb) used by finance-ui.
  enable_aws_load_balancer_controller = true
  aws_load_balancer_controller = {
    # Chart creates the default "alb" IngressClass (createIngressClassResource
    # defaults true). finance-ui references ingressClassName: alb.
    set = [{
      name  = "vpcId"
      value = module.vpc.vpc_id
    }]
  }

  tags = local.tags
}

# App-of-apps root Application — ArgoCD watches gitops/apps/ in the repo
resource "kubectl_manifest" "argocd_app_of_apps" {
  yaml_body = <<-YAML
    apiVersion: argoproj.io/v1alpha1
    kind: Application
    metadata:
      name: openclaw-apps
      namespace: argocd
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: ${var.gitops_repo_url}
        targetRevision: ${var.gitops_target_revision}
        path: gitops/apps
      destination:
        server: https://kubernetes.default.svc
        namespace: argocd
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
  YAML

  depends_on = [module.eks_blueprints_addons]
}
