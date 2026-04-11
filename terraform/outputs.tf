output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS cluster API endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_version" {
  description = "Kubernetes version"
  value       = module.eks.cluster_version
}

output "kubeconfig_cmd" {
  description = "Command to update local kubeconfig"
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "litellm_endpoint" {
  description = "LiteLLM proxy endpoint (cluster-internal)"
  value       = "http://litellm.litellm.svc.cluster.local:4000"
}

output "litellm_api_key" {
  description = "LiteLLM API key for OpenClaw agents"
  value       = "sk-${random_password.litellm_api_key.result}"
  sensitive   = true
}

output "argocd_server_url" {
  description = "ArgoCD server URL"
  value       = "https://localhost:8080 (via port-forward)"
}

output "argocd_access_cmd" {
  description = "Port-forward command to access ArgoCD UI"
  value       = "kubectl port-forward -n argocd svc/argocd-server 8080:443"
}

output "grafana_access_cmd" {
  description = "Port-forward command to access Grafana"
  value       = "kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80"
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "gitops_next_step" {
  description = "After terraform apply: replace repo URL placeholder in gitops/apps/*.yaml then push"
  value       = "sed -i '' 's|GITOPS_REPO_URL_PLACEHOLDER|${var.gitops_repo_url}|g' gitops/apps/*.yaml && git add gitops/ && git commit -m 'chore: set ArgoCD repo URL' && git push"
}
