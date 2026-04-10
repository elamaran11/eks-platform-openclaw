# eks-platform-openclaw

OpenClaw AI agents on Amazon EKS Auto Mode with Kata container isolation, Claude via AWS Bedrock, GitOps via EKS Capability for Argo CD, and Bedrock Guardrail content filtering.

![Architecture](generated-diagrams/openclaw-architecture.png)

## Architecture

- **EKS Auto Mode** — `authentication_mode = "API"` with access entries; manages Karpenter, VPC CNI, EBS CSI, CoreDNS, LB controller, Pod Identity Agent
- **EKS Capability for Argo CD** — AWS-native managed ArgoCD (`aws_eks_capability`), integrated with IAM Identity Center; app-of-apps pattern with sync waves
- **Kata bare-metal NodePool** — `m5.metal` / `c5.metal` nodes with `kata-qemu` runtime for VM-level sandbox isolation; NodePool and RuntimeClass managed by ArgoCD
- **LiteLLM proxy** — OpenAI-compatible gateway to Bedrock with Bedrock Guardrail for content filtering; Pod Identity provides AWS credentials (no static keys)
- **OpenClaw operator** — manages `Sandbox` CRDs; each sandbox runs in a Kata VM on bare-metal
- **Prometheus + Grafana** — LiteLLM metrics with alerting rules for Bedrock error rate, queue depth, and Kata node pool exhaustion

## Prerequisites

- AWS CLI configured with sufficient permissions (EKS, EC2, IAM, Bedrock)
- Terraform >= 1.7.0
- kubectl
- AWS IAM Identity Center instance (required for EKS Capability for Argo CD)
- Bedrock model access enabled for `us-west-2` (or your chosen region):
  - `anthropic.claude-sonnet-4-6-20251001-v1:0`
  - `anthropic.claude-opus-4-6-20250514-v1:0`
  - `anthropic.claude-haiku-4-5-20251001-v1:0`

## Quickstart

```bash
# 1. Get your IAM Identity Center instance ARN
aws sso-admin list-instances --query 'Instances[0].InstanceArn' --output text

# 2. Create terraform.tfvars
cat > terraform/terraform.tfvars <<EOF
gitops_repo_url  = "https://github.com/YOUR_ORG/eks-platform-openclaw"
idc_instance_arn = "arn:aws:sso:::instance/ssoins-XXXXXXXXXX"
EOF

# 3. Deploy cluster + bootstrap ArgoCD
chmod +x scripts/install.sh scripts/cleanup.sh
./scripts/install.sh

# 4. Replace repo URL in ArgoCD app manifests and push
terraform -chdir=terraform output -raw gitops_next_step | bash

# 5. Access ArgoCD UI
kubectl port-forward -n argocd svc/argocd-server 8080:443
# open https://localhost:8080

# 6. Access Grafana
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
# open http://localhost:3000 (admin / admin)

# 7. Deploy an example sandbox (edit tokens first)
kubectl apply -f manifests/sandbox-example.yaml
```

## Configuration

Key variables in `terraform/variables.tf`:

| Variable | Default | Description |
|----------|---------|-------------|
| `region` | `us-west-2` | AWS region |
| `project_name` | `openclaw` | Resource name prefix |
| `cluster_version` | `1.32` | Kubernetes version |
| `enable_kata_nodes` | `true` | Deploy bare-metal Kata node pool |
| `gitops_repo_url` | — | Git repo URL ArgoCD watches |
| `idc_instance_arn` | — | IAM Identity Center instance ARN |
| `admin_role_arns` | `[]` | Additional IAM roles granted cluster-admin |

Override via `terraform.tfvars`:

```hcl
region           = "us-east-1"
project_name     = "my-openclaw"
gitops_repo_url  = "https://github.com/my-org/eks-platform-openclaw"
idc_instance_arn = "arn:aws:sso:::instance/ssoins-XXXXXXXXXX"
admin_role_arns  = ["arn:aws:iam::123456789012:role/my-admin-role"]
```

## Project structure

```
terraform/          # Cluster bootstrap: EKS, VPC, IAM, ArgoCD capability, Bedrock Guardrail
gitops/
  apps/             # ArgoCD app-of-apps (kata, monitoring, litellm, openclaw)
  helm/
    kata/           # Kata NodePool + RuntimeClass
    monitoring/     # kube-prometheus-stack + alert rules + Grafana dashboard
    litellm/        # LiteLLM proxy with Bedrock Guardrail config
    openclaw/       # OpenClaw operator
manifests/          # sandbox-example.yaml
scripts/            # install.sh / cleanup.sh
```

## Teardown

```bash
./scripts/cleanup.sh
```
