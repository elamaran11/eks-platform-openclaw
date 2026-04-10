# EKS Capability for Argo CD — AWS-native managed ArgoCD
# https://docs.aws.amazon.com/eks/latest/userguide/argocd-concepts.html
# Requires AWS IAM Identity Center (IDC) for authentication

# IAM role the ArgoCD capability uses to interact with AWS services
resource "aws_iam_role" "argocd_capability" {
  name = "${local.cluster_name}-argocd-capability"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "eks-capability.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "argocd_capability" {
  role       = aws_iam_role.argocd_capability.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# EKS Capability for Argo CD
resource "aws_eks_capability" "argocd" {
  capability_name           = "argocd"
  cluster_name              = module.eks.cluster_name
  type                      = "ARGOCD"
  role_arn                  = aws_iam_role.argocd_capability.arn
  delete_propagation_policy = "RETAIN"

  configuration {
    argo_cd {
      namespace = "argocd"
      aws_idc {
        idc_instance_arn = var.idc_instance_arn
        idc_region       = var.region
      }
    }
  }

  tags = local.tags

  depends_on = [module.eks]
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

  depends_on = [aws_eks_capability.argocd]
}
