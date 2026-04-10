# Namespace and secrets only — ArgoCD deploys the LiteLLM Helm chart via gitops/helm/litellm/

resource "kubernetes_namespace" "litellm" {
  metadata {
    name = "litellm"
  }
  depends_on = [module.eks]
}

resource "random_password" "litellm_master_key" {
  length  = 32
  special = false
}

resource "random_password" "litellm_api_key" {
  length  = 32
  special = false
}

resource "kubernetes_secret" "litellm" {
  metadata {
    name      = "litellm-secrets"
    namespace = kubernetes_namespace.litellm.metadata[0].name
  }

  data = {
    master_key                = "sk-${random_password.litellm_master_key.result}"
    api_key                   = "sk-${random_password.litellm_api_key.result}"
    bedrock_guardrail_id      = aws_bedrock_guardrail.openclaw.guardrail_id
    bedrock_guardrail_version = aws_bedrock_guardrail_version.openclaw.version
    aws_region                = var.bedrock_region
  }
}
