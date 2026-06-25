#!/usr/bin/env bash
# Full deploy: Terraform (EKS + Karpenter + ArgoCD) → GitOps
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TERRAFORM_DIR="${ROOT_DIR}/terraform"

# ---------------- Pre-flight ----------------

echo "==> Checking prerequisites..."
for bin in terraform kubectl aws git; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not on PATH"; exit 1; }
done

if [ ! -f "${TERRAFORM_DIR}/terraform.tfvars" ]; then
  echo "ERROR: terraform/terraform.tfvars not found."
  echo "Copy the example and fill in your values:"
  echo "  cp terraform/terraform.tfvars.example terraform/terraform.tfvars"
  exit 1
fi

GITOPS_REPO_URL=$(grep '^gitops_repo_url' "${TERRAFORM_DIR}/terraform.tfvars" | sed 's/.*= *"\(.*\)"/\1/' || true)
if [ -z "${GITOPS_REPO_URL}" ]; then
  echo "ERROR: gitops_repo_url not set in terraform.tfvars"
  exit 1
fi

REGION=$(grep '^region' "${TERRAFORM_DIR}/terraform.tfvars" 2>/dev/null | sed 's/.*= *"\(.*\)"/\1/' || true)
REGION="${REGION:-us-west-2}"

# ---------------- Terraform apply ----------------

cd "${TERRAFORM_DIR}"
echo "==> Initializing Terraform..."
terraform init -upgrade

echo "==> Applying infrastructure (VPC, EKS, system MNG, Karpenter, ArgoCD, Bedrock Guardrail, Cognito, EFS)..."
terraform apply -auto-approve

CLUSTER_NAME=$(terraform output -raw cluster_name)
echo "==> Updating kubeconfig..."
aws eks update-kubeconfig --region "${REGION}" --name "${CLUSTER_NAME}"

echo "==> Waiting for system nodes to be Ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=300s

# ---------------- GitOps bootstrap ----------------

echo "==> Setting GitOps repo URL in ArgoCD app manifests..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  SED_INPLACE=(-i '')
else
  SED_INPLACE=(-i)
fi
sed "${SED_INPLACE[@]}" "s|GITOPS_REPO_URL_PLACEHOLDER|${GITOPS_REPO_URL}|g" "${ROOT_DIR}/gitops/apps/"*.yaml
git -C "${ROOT_DIR}" add gitops/
git -C "${ROOT_DIR}" diff --cached --quiet || git -C "${ROOT_DIR}" commit -m "chore: set ArgoCD repo URL"
git -C "${ROOT_DIR}" push

# ---------------- Done ----------------

echo ""
echo "==> Deploy complete. ArgoCD will sync all waves from your Git repo."
echo ""
echo "  ArgoCD UI:  kubectl port-forward -n argocd svc/argo-cd-argocd-server 8080:443"
echo "  Grafana UI: kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80"
echo "  Apps:       kubectl get applications -n argocd"
echo "  Sandboxes:  kubectl get sandbox -A"
echo ""
echo "==> OPTIONAL: Create Slack tokens secret for the Slack sandbox agent"
echo ""
echo "    kubectl create secret generic slack-tokens -n openclaw \\"
echo "      --from-literal=bot-token=\"xoxb-...\" \\"
echo "      --from-literal=app-token=\"xapp-...\" \\"
echo "      --from-literal=signing-secret=\"...\""
echo ""
echo "==> OPTIONAL: Render + push the finance-ui deployment (after the first terraform apply)"
echo ""
echo "    ./scripts/render-finance-ui.sh <image-tag>   # e.g. v0.9.7"
echo ""
echo "Outputs:"
echo "  LiteLLM API key:       $(terraform output -raw litellm_api_key 2>/dev/null || echo '(not yet available)')"
echo "  Bedrock Guardrail ID:  $(terraform output -raw bedrock_guardrail_id 2>/dev/null || echo '(not yet available)')"
echo "  Finance UI host:       $(terraform output -raw finance_ui_host 2>/dev/null || echo '(not yet available)')"
echo ""
