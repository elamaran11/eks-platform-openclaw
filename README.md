# EKS Platform for OpenClaw

**Production-grade AI agents with hardware-level sandbox isolation on Amazon EKS.**

Every agent conversation runs inside a Kata Containers QEMU virtual machine on bare-metal EC2. Not just a container — an actual VM with its own kernel. Agents connect to Slack, reason with Claude via AWS Bedrock, and are deployed entirely through GitOps.

![Architecture](generated-diagrams/openclaw-architecture.png)

---

## Why this architecture

### The problem with running AI agents in containers

AI agents execute code, browse the web, read files, and call external APIs. A compromised or misbehaving agent in a standard container can escape to the host kernel, access other workloads' memory, or pivot across the cluster. For production agent deployments, that's not acceptable.

### The solution: hardware VM isolation per agent

This platform runs each OpenClaw agent inside a **Kata Containers QEMU virtual machine** on bare-metal EC2 (`c5.metal` / `m5.metal`). The agent process is isolated at the hardware level — it has its own kernel, its own memory space, and cannot escape to the host regardless of what it executes. The VM boundary is enforced by the CPU, not by Linux namespaces.

This is the same isolation model used by AWS Fargate and AWS Lambda under the hood.

---

## Key design decisions

### 1. Kata Containers on bare-metal, not Fargate or Lambda

Fargate gives you VM isolation but no control over the runtime. Lambda gives you isolation but no persistent state or long-running processes. OpenClaw agents need persistent workspace, long-running sessions, and direct Kubernetes API access for tool use. Kata on bare-metal gives all of that with full control.

**Bare-metal matters**: Kata requires hardware virtualization (VT-x/AMD-V). Nested virtualization on regular EC2 instances adds overhead and instability. `c5.metal` and `m5.metal` give direct hardware access — no hypervisor layer between the VM and the CPU.

### 2. Karpenter for all workload nodes (no EKS Auto Mode)

The cluster runs a small **managed system nodegroup** (2× `m5.large`) for ArgoCD, Karpenter itself, CoreDNS, monitoring, LiteLLM, and the UI/router pods. Everything else — including the kata bare-metal nodes — is provisioned by **Karpenter** via two NodePools:

- `kata-nested` — `c8i` / `m8i` nested-virt, spot + on-demand (default; cheaper)
- `kata-metal` — `c5.metal` / `i3.metal` / `m5.metal` on-demand (fallback)

Both NodePools are labeled `katacontainers.io/kata-runtime=true` and tainted `kata=true:NoSchedule`, so only kata-runtimeClass pods can schedule on them. Karpenter picks the cheapest node that satisfies the workload's requirements, scales to zero when idle, and replaces interrupted spot nodes automatically.

**EKS Auto Mode is intentionally NOT used.** Auto Mode's built-in Karpenter does not support the custom AMI or the kata-deploy containerd config overlay that kata requires. Running Karpenter ourselves lets us:
- Bind the kata NodePools to a Packer-baked AMI that has QEMU + kata pre-installed
- Inject `containerd` runtime config via Karpenter `EC2NodeClass.userData`
- Keep the system MNG tiny so bare-metal spend is purely demand-driven

### 3. Pre-baked Kata AMI with Packer

Installing QEMU + Kata Containers 3.27.0 + Cloud Hypervisor on every node boot is slow (~4 min) and fragile (package repos change). Instead, a **Packer build** runs once per cluster creation (or on `force_rebake=true`), producing a private AMI `openclaw-kata-<timestamp>` based on EKS-optimized AL2023 with everything pre-installed.

`scripts/install.sh` automates this: packer builds the AMI, writes the ID to `terraform/terraform.auto.tfvars`, and `terraform apply` wires the AMI into both Karpenter NodePools via the `kata_ami_id` variable. Subsequent applies reuse the same AMI and skip the bake.

### 4. LiteLLM as the model gateway

Direct Bedrock API calls from agents would require each agent pod to have AWS credentials and know Bedrock's API format. LiteLLM provides an OpenAI-compatible endpoint that:
- Abstracts the model provider (swap Bedrock for OpenAI or Anthropic without changing agent code)
- Centralizes API key management with PostgreSQL persistence
- Applies Bedrock Guardrails transparently to every request
- Exposes Prometheus metrics for observability

### 5. EKS Pod Identity instead of static keys

No IAM user keys, no environment variable secrets for AWS access. EKS Pod Identity binds an IAM role directly to the LiteLLM service account. Credentials are rotated automatically, scoped to the pod, and auditable via CloudTrail. The kata agent pods never touch AWS credentials directly.

### 6. Bedrock Guardrail at the proxy layer

Content filtering and PII anonymization happen at LiteLLM, not in the agent. This means:
- Every model call is filtered regardless of which agent makes it
- PII (email, phone, AWS keys) is anonymized before reaching the model
- Guardrail configuration is centralized and auditable
- Agents can't bypass filtering by calling Bedrock directly (they don't have credentials)

### 7. ArgoCD app-of-apps with sync waves

The platform has strict deployment ordering requirements: Karpenter must be up before any non-system node can be provisioned, kata runtime must be installed before agent pods schedule, LiteLLM must be up before agents start. ArgoCD sync waves enforce this:

```
Wave -1: karpenter, agent-sandbox        # Karpenter controller + Sandbox CRD
Wave  0: karpenter-nodepools, kata       # NodePools + EC2NodeClass, kata StorageClass
Wave  1: kata-deploy, monitoring          # kata-qemu runtime install, Prometheus
Wave  2: litellm                          # OpenAI-compat proxy to Bedrock
Wave  3: openclaw, external-dns,          # Operator, DNS, ALB IngressClass
         ingressclass-alb
Wave  4: finance-assistant, slack         # Workload apps (Sandbox CRs, ConfigMaps)
Wave  5: finance-assistant-ui             # UI + ALB Ingress + Cognito
```

---

## What you get

| Capability | Detail |
|---|---|
| Agent isolation | Kata QEMU VM per agent — hardware boundary, own kernel |
| Model access | Claude Sonnet 4.6, Opus 4, Haiku 4.5 via Bedrock cross-region inference |
| Content safety | Bedrock Guardrail — PII anonymization + content filtering on every request |
| Credentials | EKS Pod Identity — no static keys anywhere |
| Deployment | ArgoCD app-of-apps — full GitOps, sync waves, self-healing |
| Observability | Prometheus + Grafana — LiteLLM request rate, latency, token usage |
| Slack integration | Socket Mode WebSocket — DMs and @mentions, no public endpoint needed |
| Persistence | PostgreSQL for LiteLLM key store, EmptyDir workspace per agent session |

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

# 2. Deploy everything (~15 minutes)
chmod +x scripts/install.sh
./scripts/install.sh

# 3. Set up Slack tokens
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

## Slack integration

Claw-bot connects to Slack via Socket Mode — no public endpoint or ingress required. Once deployed, you can interact with it directly from any Slack channel or DM.

![Claw-bot in Slack](generated-diagrams/claw-bot-Slack.png)

**How to interact:**
- **DM the bot** — send any message directly to Claw-bot for a private conversation
- **Mention in a channel** — `@Claw-bot <your prompt>` to invoke it in a shared channel
- The bot responds in-thread, keeping channels clean
- The bot runs inside a Kata QEMU VM — hardware-isolated from the host and other cluster workloads

---

## Slack app setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** → generate an App-Level Token (`xapp-...`)
3. Add Bot Token Scopes: `channels:history`, `channels:read`, `im:history`, `im:read`, `im:write`, `chat:write`, `app_mentions:read`
4. Install to your workspace → copy the Bot Token (`xoxb-...`)
5. Create the secret (step 3 above) — the sandbox connects automatically

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `region` | `us-west-2` | AWS region |
| `project_name` | `openclaw` | Resource name prefix |
| `cluster_version` | `1.32` | Kubernetes version |
| `enable_kata_nodes` | `true` | Enable Karpenter kata NodePools + bake Kata AMI |
| `kata_ami_id` | — | Packer-baked AMI ID (written by `scripts/install.sh`) |
| `force_rebake` | `false` | Force packer to rebuild the AMI on next apply |
| `gitops_repo_url` | — | Git repo ArgoCD watches |
| `gitops_target_revision` | `main` | Git branch/tag ArgoCD tracks |
| `bedrock_region` | `us-west-2` | Bedrock inference region |

---

## Project structure

```
packer/
  kata-ami.pkr.hcl    # Pre-bakes Kata 3.27 + QEMU + Cloud Hypervisor onto AL2023
  install-kata.sh     # Provisioner script executed inside the Packer build

terraform/
  eks.tf              # EKS cluster — managed system nodegroup, cluster addons
                      # (no Auto Mode; Karpenter handles workload nodes)
  karpenter.tf        # Karpenter controller IAM/SQS, EKS access entry
  packer-bake.tf      # Validates kata_ami_id is populated; exports as output
  litellm.tf          # LiteLLM namespace, secrets, API key
  bedrock_guardrail.tf
  cognito.tf, cognito_ui.tf  # User pool + hosted UI branding
  lambda_presignup.tf # @amazon.com-only signup enforcement
  efs.tf              # EFS filesystem for per-user finance-assistant workspaces

gitops/
  apps/               # ArgoCD Applications (app-of-apps)
    karpenter.yaml            # Karpenter controller (wave -1)
    agent-sandbox.yaml        # Sandbox CRD (wave -1)
    karpenter-nodepools.yaml  # NodePools + EC2NodeClass (wave 0)
    kata.yaml                 # kata StorageClass (wave 0)
    kata-deploy.yaml          # kata-qemu runtime installer (wave 1)
    monitoring.yaml           # Prometheus + Grafana (wave 1)
    litellm.yaml              # LiteLLM proxy (wave 2)
    openclaw.yaml             # OpenClaw operator (wave 3)
    external-dns.yaml         # Route53 external-dns (wave 3)
    ingressclass-alb.yaml     # ALB IngressClass (wave 3)
    finance-assistant.yaml    # Finance-assistant namespace + sandbox (wave 4)
    slack.yaml                # Slack sandbox (wave 4)

  helm/
    karpenter-nodepools/  # kata-nested + kata-metal NodePools, EC2NodeClass
    kata-deploy/          # kata-deploy DaemonSet + kubelet-restart DaemonSet
    litellm/              # LiteLLM proxy with sitecustomize.py Bedrock patch
    openclaw/             # OpenClaw Sandbox CRD + related manifests

examples/
  finance-assistant/    # Per-user finance-assistant app (Sandbox + web-ui + router)
  slack/                # Slack-as-frontend Sandbox

scripts/
  install.sh            # Full deploy: packer bake → terraform apply → ArgoCD bootstrap
  cleanup.sh            # Full teardown
  render-finance-ui.sh  # Substitutes terraform outputs into finance-ui deployment.yaml
```

---

## How kata nodes bootstrap

Since we run Karpenter ourselves (not EKS Auto Mode's built-in), getting kata nodes to Ready is a clean sequence — no `aws-node` DaemonSet for non-auto-mode nodes, no kube-proxy affinity workarounds. Order:

1. **Packer-baked AMI** (before terraform apply) — `scripts/install.sh` runs Packer to produce `openclaw-kata-<timestamp>` with Kata 3.27 + QEMU + Cloud Hypervisor already installed. Writes the AMI ID to `terraform/terraform.auto.tfvars`.

2. **Karpenter controller** (ArgoCD wave -1) — installed via the upstream Karpenter Helm chart, uses IRSA via Pod Identity. Watches Pending pods and provisions nodes on demand.

3. **Karpenter NodePools + EC2NodeClass** (ArgoCD wave 0) — `kata-nested` and `kata-metal` NodePools both reference the baked AMI by ID and apply containerd userData for the kata-qemu runtime. Subnet + SG discovery via `karpenter.sh/discovery=<cluster-name>` tag.

4. **kata-deploy DaemonSet** (ArgoCD wave 1) — DaemonSet runs only on nodes labeled `katacontainers.io/kata-runtime=true` (which Karpenter applies from the NodePool). It installs the `kata-qemu` RuntimeClass and symlinks binaries — most of the work is already done because the AMI is pre-baked.

5. **Workload pods** with `runtimeClassName: kata-qemu` — Karpenter sees a Pending pod with the required taint toleration + nodeSelector, provisions a kata NodePool node, the pod schedules, the QEMU VM boots.

---

## Teardown

```bash
./scripts/cleanup.sh
```

---

## License

MIT
