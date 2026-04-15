# OpenClaw on EKS

> AI agents with VM-level isolation, running on bare-metal Kubernetes — powered by Claude via AWS Bedrock.

![Architecture](generated-diagrams/openclaw-architecture.png)

---

## What is this?

A production-grade platform for running [OpenClaw](https://openclaw.ai) AI agents on Amazon EKS with **hardware-level sandbox isolation**. Every agent conversation runs inside a Kata Containers VM on bare-metal EC2 — not just a container, an actual virtual machine. Agents connect to Slack, use Claude models via AWS Bedrock, and are fully managed through GitOps.

---

## Why it's different

| Feature | This platform | Typical AI deployment |
|---|---|---|
| Agent isolation | Kata VM on bare-metal (hardware boundary) | Shared container namespace |
| Model access | Bedrock cross-region inference profiles | Direct API keys in env vars |
| Credentials | EKS Pod Identity (no static keys) | IAM user keys or instance profiles |
| Deployment | ArgoCD app-of-apps, fully GitOps | kubectl apply / helm install |
| Observability | Prometheus + Grafana with LiteLLM metrics | Logs only |
| Content safety | Bedrock Guardrail (PII anonymization, content filtering) | None |

---

## Architecture

```
Slack ──► OpenClaw Sandbox (Kata VM)
               │
               ▼
         LiteLLM Proxy  ──► AWS Bedrock (Claude Sonnet 4.6 / Opus / Haiku)
               │                    │
               │              Bedrock Guardrail
               │
         PostgreSQL (key store)
               │
         Prometheus + Grafana
```

### Key components

**EKS Auto Mode** — Manages the control plane, Karpenter, VPC CNI, EBS CSI, CoreDNS, and load balancing automatically. General-purpose and system node pools run on auto-mode. Kata nodes run as a dedicated EKS managed node group (non-auto-mode) on `c5.metal` / `m5.metal` bare-metal instances.

**Kata Containers** — Each OpenClaw sandbox pod runs with `runtimeClassName: kata-qemu`. The agent process is isolated inside a QEMU virtual machine — a compromised agent cannot escape to the host kernel. `kata-deploy` installs the runtime on bare-metal nodes via a DaemonSet managed by ArgoCD.

**LiteLLM Proxy** — OpenAI-compatible gateway that routes requests to Bedrock. Handles API key management, model routing, and strips OpenAI-specific parameters (like `store`) that Bedrock doesn't support. Backed by PostgreSQL for key persistence.

**OpenClaw Operator** — Manages `Sandbox` CRDs. Each sandbox is a long-running agent process with a persistent workspace, Slack channel integration, and access to tools (browser, file system, code execution).

**ArgoCD App-of-Apps** — All platform components are deployed via GitOps with sync waves ensuring correct ordering: CNI → kata runtime → LiteLLM → OpenClaw operator → sandboxes.

**Bedrock Guardrail** — Content filtering with PII anonymization (email, phone, AWS keys) and content policy enforcement applied at the LiteLLM proxy layer.

---

## Prerequisites

- AWS CLI configured (`AdministratorAccess` or equivalent)
- Terraform >= 1.7.0
- kubectl
- Bedrock model access enabled in `us-west-2`:
  - `us.anthropic.claude-sonnet-4-6`
  - `us.anthropic.claude-opus-4-20250514-v1:0`
  - `us.anthropic.claude-3-5-haiku-20241022-v1:0`

---

## Deploy

```bash
# 1. Clone and configure
git clone https://github.com/YOUR_ORG/eks-platform-openclaw
cd eks-platform-openclaw

cat > terraform/terraform.tfvars <<EOF
gitops_repo_url = "https://github.com/YOUR_ORG/eks-platform-openclaw"
EOF

# 2. Deploy everything
chmod +x scripts/install.sh
./scripts/install.sh

# 3. Set up Slack integration
kubectl create secret generic slack-tokens \
  --namespace openclaw \
  --from-literal=bot-token=xoxb-YOUR-BOT-TOKEN \
  --from-literal=app-token=xapp-YOUR-APP-TOKEN \
  --from-literal=signing-secret=YOUR-SIGNING-SECRET

# 4. Access ArgoCD
kubectl port-forward -n argocd svc/argo-cd-argocd-server 8080:443
# https://localhost:8080

# 5. Access Grafana
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
# http://localhost:3000 (admin / prom-operator)
```

---

## Slack setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** and generate an App-Level Token (`xapp-...`)
3. Add Bot Token Scopes: `channels:history`, `channels:read`, `im:history`, `im:read`, `im:write`, `chat:write`, `app_mentions:read`
4. Install the app to your workspace and copy the Bot Token (`xoxb-...`)
5. Create the secret (step 3 above) and the sandbox will connect automatically

---

## Configuration

Key variables in `terraform/variables.tf`:

| Variable | Default | Description |
|---|---|---|
| `region` | `us-west-2` | AWS region |
| `project_name` | `openclaw` | Resource name prefix |
| `cluster_version` | `1.32` | Kubernetes version |
| `enable_kata_nodes` | `true` | Deploy bare-metal Kata node group |
| `kata_instance_types` | `["c5.metal","m5.metal"]` | Bare-metal instance types |
| `gitops_repo_url` | — | Git repo ArgoCD watches |
| `bedrock_region` | `us-west-2` | Bedrock inference region |

---

## Project structure

```
terraform/          # EKS cluster, VPC, IAM, Bedrock Guardrail, LiteLLM secrets
  eks.tf            # EKS Auto Mode + addons (vpc-cni, kube-proxy, ebs-csi)
  kata.tf           # Kata managed node group (bare-metal, 100GB disk)
  litellm.tf        # LiteLLM namespace, secrets, API key
  bedrock_guardrail.tf

gitops/
  apps/             # ArgoCD Applications (app-of-apps pattern)
    kata.yaml       # StorageClass (sync-wave 0)
    kata-deploy.yaml    # Kata runtime installer (sync-wave 1)
    aws-node-kata.yaml  # VPC CNI for kata nodes (sync-wave -1)
    litellm.yaml    # LiteLLM proxy (sync-wave 2)
    openclaw.yaml   # OpenClaw operator + sandbox (sync-wave 3)
    monitoring.yaml # Prometheus + Grafana (sync-wave 1)

  helm/
    kata/           # StorageClass (ebs-gp3 default)
    kata-deploy/    # kata-deploy DaemonSet + kubelet-restart DaemonSet
    aws-node/       # VPC CNI DaemonSet for non-auto-mode kata nodes
    litellm/        # LiteLLM proxy with sitecustomize.py Bedrock patch
    openclaw/       # OpenClaw operator + Sandbox CRD
    monitoring/     # kube-prometheus-stack + Grafana dashboards

scripts/
  install.sh        # Full deploy: terraform + ArgoCD bootstrap
  cleanup.sh        # Full teardown
```

---

## How kata nodes work

EKS Auto Mode doesn't deploy `aws-node` (VPC CNI) to non-auto-mode nodes. The kata managed node group needs explicit CNI to become Ready. This platform handles it with:

1. **`vpc-cni` EKS addon** — deployed by terraform, ensures CNI is available before the node group creation times out
2. **`kata-deploy` DaemonSet** — installs kata-qemu runtime binaries on bare-metal nodes; targets `katacontainers.io/kata-runtime=true` label (only set after installation completes)
3. **`kata-kubelet-restart` DaemonSet** — kata-deploy restarts containerd during installation, breaking the kubelet's CRI connection; this DaemonSet restarts kubelet after installation to reconnect it
4. **`kube-proxy` addon** — patched via terraform `configuration_values` to include managed node group nodes (default only targets auto-mode nodes)

---

## Observability

LiteLLM exports Prometheus metrics. Grafana dashboards include:

- Request rate and latency per model
- Bedrock error rate (guardrail interventions, throttling)
- Token usage
- Kata node pool capacity

---

## Teardown

```bash
./scripts/cleanup.sh
```

---

## License

MIT
