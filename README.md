# EKS Platform for OpenClaw

**Production-grade AI agents with hardware-level sandbox isolation on Amazon EKS.**

Every agent conversation runs inside a Kata Containers QEMU virtual machine on EC2 instances with hardware virtualization (nested-virt `c8i`/`m8i` by default). Not just a container — an actual VM with its own kernel. Agents connect to Slack, reason with Claude via AWS Bedrock, and are deployed entirely through GitOps.

![Architecture](generated-diagrams/openclaw-architecture.png)

---

## Why this architecture

### The problem with running AI agents in containers

AI agents execute code, browse the web, read files, and call external APIs. A compromised or misbehaving agent in a standard container can escape to the host kernel, access other workloads' memory, or pivot across the cluster. For production agent deployments, that's not acceptable.

### The solution: hardware VM isolation per agent

This platform runs each OpenClaw agent inside a **Kata Containers QEMU virtual machine** on EC2 instances with hardware virtualization — by default `c8i` / `m8i` instances with **nested virtualization** enabled, with bare-metal (`c5.metal` / `m5.metal`) as a fallback. The agent process is isolated at the hardware level — it has its own kernel, its own memory space, and cannot escape to the host regardless of what it executes. The VM boundary is enforced by the CPU, not by Linux namespaces.

This is the same isolation model used by AWS Fargate and AWS Lambda under the hood.

---

## Key design decisions

### 1. Kata Containers on EC2, not Fargate or Lambda

Fargate gives you VM isolation but no control over the runtime. Lambda gives you isolation but no persistent state or long-running processes. OpenClaw agents need persistent workspace, long-running sessions, and direct Kubernetes API access for tool use. Kata on EC2 (nested-virt `8i` instances, or bare-metal as fallback) gives all of that with full control.

**Hardware virtualization matters**: Kata requires VT-x/AMD-V. Historically that meant bare-metal `.metal` instances, since regular instances hid the CPU virtualization extensions. AWS now exposes them on `8i`-family instances (`c8i` / `m8i` / `r8i`) via **nested virtualization** (`cpuOptions.nestedVirtualization=enabled`) — the Nitro hypervisor (L0) passes Intel VT-x through to the instance (L1) so Kata's QEMU can run guest VMs (L2). This is cheaper and faster to provision than bare-metal, which is kept only as a fallback for capacity or latency-sensitive workloads.

### 2. Karpenter for all workload nodes (no EKS Auto Mode)

The cluster runs a small **managed system nodegroup** (2× `m5.large`) for ArgoCD, Karpenter itself, CoreDNS, monitoring, LiteLLM, and the UI/router pods. Everything else — including the kata bare-metal nodes — is provisioned by **Karpenter** via two NodePools:

- `kata-nested` — `c8i` / `m8i` nested-virt, spot + on-demand (default; cheaper)
- `kata-metal` — `c5.metal` / `i3.metal` / `m5.metal` on-demand (fallback)

Both NodePools are labeled `katacontainers.io/kata-runtime=true` and tainted `kata=true:NoSchedule`, so only kata-runtimeClass pods can schedule on them. Karpenter picks the cheapest node that satisfies the workload's requirements, scales to zero when idle, and replaces interrupted spot nodes automatically.

**EKS Auto Mode is intentionally NOT used.** Auto Mode's built-in Karpenter does not let us set `cpuOptions.nestedVirtualization` on launch or load the KVM kernel module that kata requires. Running Karpenter ourselves lets us:
- Enable nested virtualization per NodePool via `EC2NodeClass.cpuOptions.nestedVirtualization=enabled`
- Load `kvm_intel` at boot via `EC2NodeClass.userData` so `/dev/kvm` exists before kata-deploy runs
- Keep the system MNG tiny so kata node spend is purely demand-driven

### 3. Kata runtime installed at boot by kata-deploy (no baked AMI)

Nodes run the **stock EKS-optimized AL2023 AMI** (`alias: al2023@latest`). The Kata runtime — binaries, guest kernel, `configuration-*.toml`, the containerd runtime handler, and the `kata-qemu` RuntimeClass — is installed at runtime by the upstream **`kata-deploy` DaemonSet** (`gitops/helm/kata-deploy`), which patches containerd and restarts it on each kata node.

The one thing kata-deploy does *not* do is load host kernel modules, so the `EC2NodeClass.userData` runs `modprobe kvm_intel` (and persists it to `/etc/modules-load.d/kvm.conf`) at boot — `cpuOptions.nestedVirtualization` only makes VT-x *visible*; the guest OS must still load the module to create `/dev/kvm`. This removes the previous Packer bake step entirely: no custom AMI to build or maintain, and the Kata version is bumped by changing the `kata-deploy` chart version alone.

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
| `cluster_version` | `1.36` | Kubernetes version |
| `gitops_repo_url` | — | Git repo ArgoCD watches |
| `gitops_target_revision` | `main` | Git branch/tag ArgoCD tracks |
| `bedrock_region` | `us-west-2` | Bedrock inference region |

---

## Project structure

```
terraform/
  eks.tf              # EKS cluster — managed system nodegroup, cluster addons
                      # (no Auto Mode; Karpenter handles workload nodes)
  karpenter.tf        # Karpenter controller IAM/SQS, EKS access entry
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
    kata-deploy/          # kata-deploy DaemonSet + kata-readiness startup-taint gate
    litellm/              # LiteLLM proxy with sitecustomize.py Bedrock patch
    openclaw/             # OpenClaw Sandbox CRD + related manifests

examples/
  finance-assistant/    # Per-user finance-assistant app (Sandbox + web-ui + router)
  slack/                # Slack-as-frontend Sandbox

scripts/
  install.sh            # Full deploy: terraform apply → ArgoCD bootstrap
  cleanup.sh            # Full teardown
  render-finance-ui.sh  # Substitutes terraform outputs into finance-ui deployment.yaml
```

---

## How kata nodes bootstrap

Since we run Karpenter ourselves (not EKS Auto Mode's built-in), getting kata nodes to Ready is a clean sequence — no `aws-node` DaemonSet for non-auto-mode nodes, no kube-proxy affinity workarounds. Order:

1. **Terraform apply** — `scripts/install.sh` provisions VPC, EKS, the system MNG, Karpenter IAM/SQS, and ArgoCD. No AMI bake step; nodes use the stock EKS-optimized AL2023 AMI.

2. **Karpenter controller** (ArgoCD wave -1) — installed via the upstream Karpenter Helm chart, uses IRSA via Pod Identity. Watches Pending pods and provisions nodes on demand.

3. **Karpenter NodePools + EC2NodeClass** (ArgoCD wave 0) — `kata-nested` and `kata-metal` NodePools use the `al2023@latest` AMI alias. The `kata-nested` EC2NodeClass sets `cpuOptions.nestedVirtualization=enabled`; both run `modprobe kvm_intel` in `userData` so `/dev/kvm` exists before kata-deploy lands. Subnet + SG discovery via `karpenter.sh/discovery=<cluster-name>` tag.

4. **kata-deploy DaemonSet** (ArgoCD wave 1) — runs only on nodes labeled `katacontainers.io/kata-runtime=true` (which Karpenter applies from the NodePool). It installs the Kata binaries + guest kernel, patches containerd for the `kata-qemu` runtime, creates the `kata-qemu` RuntimeClass, and restarts containerd. A companion `kata-readiness` DaemonSet watches the kata-deploy pod's `/readyz` and removes the `katacontainers.io/runtime-not-ready` startup taint once install completes, so no kata workload binds before the runtime is ready. (kubelet's CRI client reconnects to containerd on its own; the old `kata-kubelet-restart` DaemonSet is parked in `_kata-kubelet-restart.yaml.disabled` if a deploy ever needs it.)

5. **Workload pods** with `runtimeClassName: kata-qemu` — Karpenter sees a Pending pod with the required taint toleration + nodeSelector, provisions a kata NodePool node, the pod schedules, the QEMU VM boots.

---

## Teardown

```bash
./scripts/cleanup.sh
```

---

## License

MIT
