# Architecture

## Cluster layout

- **1 EKS cluster** (`openclaw-eks`, Kubernetes 1.36) in a 3-AZ VPC (`10.0.0.0/16`).
- **Managed system nodegroup** — 2× m5.large. Runs ArgoCD, Karpenter, CoreDNS, EFS CSI, kube-proxy, VPC CNI, Pod Identity agent, monitoring, LiteLLM, session-router, finance-ui.
- **Karpenter** provisions workload nodes on demand. Four NodePools, one per
  VMM × instance-class combination:

  | NodePool | VMM(s) | Instances | Label | Taint |
  |---|---|---|---|---|
  | `kata-nested` | qemu, clh | c8i/m8i nested-virt (default) | `katacontainers.io/kata-runtime=true` | `kata=true` |
  | `kata-metal` | qemu, clh | c5/i3/m5 `.metal` (fallback) | `katacontainers.io/kata-runtime=true` | `kata=true` |
  | `kata-fc` | firecracker | c8i/m8i nested-virt | `katacontainers.io/kata-runtime-fc=true` | `kata-fc=true` |
  | `kata-fc-metal` | firecracker | c5/i3/m5 `.metal` (fallback) | `katacontainers.io/kata-runtime-fc=true` | `kata-fc=true` |

  Firecracker gets its own pools + taint/label because it needs a **devmapper**
  block snapshotter (set up in `userData`), whereas qemu/clh use overlayfs — so
  fc must never co-locate with them. Workloads pick a VMM purely via
  `runtimeClassName` (`kata-qemu` / `kata-clh` / `kata-fc`); the RuntimeClass
  carries the matching nodeSelector + toleration to steer onto the right pool.
- **No EKS Auto Mode.** Auto Mode's built-in Karpenter does not let us set `cpuOptions.nestedVirtualization` at launch or run a `modprobe` in userData, both of which the kata VMMs require. Running Karpenter ourselves lets us enable nested virtualization per NodePool, load `kvm_intel` (and the devmapper thin-pool for fc) at boot via `EC2NodeClass.userData`, and use the stock AL2023 AMI (kata-deploy installs the runtime at boot — no custom AMI).

## Waves

| Wave | Apps | What |
|---|---|---|
| -1 | karpenter, agent-sandbox | Prereqs: Karpenter controller (upstream Helm chart) + Sandbox CRDs |
| 0 | karpenter-nodepools, kata | NodePools (kata-nested, kata-metal, kata-fc, kata-fc-metal) + EC2NodeClasses; kata StorageClass + the qemu/clh/fc RuntimeClasses |
| 1 | kata-deploy, kata-deploy-fc, monitoring | qemu+clh runtime install (kata-deploy) and firecracker runtime install (kata-deploy-fc), each with its own kata-readiness startup-taint gate; Prometheus/Grafana |
| 2 | litellm | OpenAI-compat proxy to Bedrock with Guardrails + sitecustomize |
| 3 | openclaw, external-dns, ingressclass-alb | Operator (if any), DNS, ALB IngressClass |
| 4 | finance-assistant, slack | SandboxTemplate + SandboxWarmPool + shared EFS PVC + NetworkPolicies + ConfigMaps + session-router |
| 5 | finance-assistant-ui | React UI + ALB Ingress + Cognito |

ArgoCD reconciles in wave order. Within a wave, Applications sync in parallel.

## Data flow

### Finance Assistant (web UI)

```
Browser ──HTTPS──▶ ALB ──HTTP──▶ finance-ui (Next.js)
                                   │  /api/auth/* → Cognito (direct API)
                                   │  /api/warmup → finance-session-router
                                   │  /api/chat   → finance-session-router (SSE)
                                   ▼
                            finance-session-router
                                   │ hash(sub) → user-suffix
                                   │ get-or-create SandboxClaim (warm-bind, with retry)
                                   │ read bound Sandbox.status.serviceFQDN
                                   ▼
                       warm-bound sandbox (SandboxWarmPool)
                       ┌─────────────────────────┐
                       │ openclaw (:18789)       │
                       │    ▲ loopback           │
                       │ adapter (:18790)        │
                       │    │ SSE               │
                       │    ▼                    │
                       └─────────────────────────┘
                                   │ HTTP :4000
                                   ▼
                            LiteLLM (Pod Identity)
                                   │
                                   ▼
                       Bedrock Guardrail + Claude Haiku 4.5

Auth: Cognito User Pool, direct API (not ALB OIDC). Pre-signup Lambda blocks
non-@amazon.com and auto-confirms amazon emails. Session cookie `fa_session`
is a JWT carrying only {sub, email} (under 1.5KB so Chromium doesn't drop it).

Warmup: finance-ui fires /api/warmup on sign-in success so the per-user Kata
pod is provisioned in the background while the user is deciding what to ask.
Three @amazon.com fences: Cognito pre-signup Lambda, client-side domain
check, server-side check in /api/warmup.

Per-user state: a shared RWX EFS volume is mounted at /workspace in every
sandbox; the adapter provisions a dedicated openclaw agent rooted at
/workspace/users/<suffix> on first use. The SandboxClaim's sliding lifecycle
lease deletes the bound Sandbox after 30m idle (no reaper CronJob); EFS data
lives outside the lifecycle and persists, so the next sign-in re-provisions
the agent onto the same subdir.
```

### Slack

```
Slack (user DM) ──Socket Mode──▶ openclaw-slack-sandbox ──▶ LiteLLM ──▶ Bedrock
                     (outbound WS, no public ingress)
```

## Secrets

| Secret | Source | Used by |
|---|---|---|
| `litellm-secrets` (master/api keys, Guardrail IDs) | Terraform `random_password` + kubernetes_secret | LiteLLM pod, LiteLLM consumers |
| `openclaw-litellm-key` | same api-key as above, projected to tmpfs | Sandbox pods |
| `openclaw-gateway-auth` | Terraform `random_password` | Gateway auth for session-router → sandbox |
| `slack-tokens` | User-created (`kubectl create secret`) | slack sandbox |
| `finance-litellm-key` | Copy of openclaw-litellm-key (ns-scoped) | finance-assistant pods |

Secrets mount as tmpfs files (mode 0400) under `/var/run/openclaw/`. No env vars.

## IAM (Pod Identity)

| Role | Pod | Privileges |
|---|---|---|
| `KarpenterControllerRole-*` | `kube-system/karpenter` | EC2 RunInstances + SQS + DescribeCluster |
| `KarpenterNodeRole-*` | EC2 nodes Karpenter launches | Worker, CNI, ECR read, SSM |
| `openclaw-eks-litellm-bedrock` | `litellm/litellm` | `bedrock:InvokeModel*`, `bedrock:ApplyGuardrail` |
| `openclaw-eks-ebs-csi` | `kube-system/ebs-csi-controller-sa` | EBS CSI (IRSA) |
| `openclaw-eks-efs-csi` | `kube-system/efs-csi-controller-sa` | EFS CSI (IRSA) |

## Storage

- **EBS gp3** for system workloads (ArgoCD, LiteLLM pg, monitoring) via `gp3` StorageClass.
- **EFS** for per-user workspaces via `efs-workspaces` StorageClass with dynamic access points. One PVC per user, `subPath=<user-suffix>`. Survives Sandbox deletion.

## Networking

- VPC CIDR `10.0.0.0/16`, 3 private + 3 public subnets across 3 AZs.
- Karpenter discovers subnets + SG by tag `karpenter.sh/discovery=openclaw-eks`.
- NetworkPolicies restrict sandbox egress to LiteLLM:4000 and kube-dns:53 only.
- ALB Ingress for finance-ui (Cognito-authed).
- EFS security group allows NFS (2049) only from the EKS node SG.

## AMI & Kata runtime

Nodes use the **stock EKS-optimized AL2023 AMI** (`alias: al2023@latest`) — no custom AMI is baked. The Kata runtime is installed at boot by upstream **kata-deploy DaemonSets** (one per VMM family):

- **kata-deploy** (`gitops/helm/kata-deploy`) targets the `kata-nested` + `kata-metal` pools (label `kata-enabled=true`) and installs the **qemu** and **clh** (Cloud Hypervisor) shims into `/opt/kata`, patching containerd for the `kata-qemu` / `kata-clh` runtime handlers.
- **kata-deploy-fc** (`gitops/helm/kata-deploy-fc`) is a second release of the same chart, scoped to the `kata-fc` + `kata-fc-metal` pools (label `kata-fc-enabled=true`), enabling **only the firecracker shim** so it never touches the qemu nodes. It runs with `env.multiInstallSuffix=fc` to avoid Kubernetes object-name collisions with the first release, so its install lands in `/opt/kata-fc` and its containerd handler is `kata-fc-fc`.
- 250 GB gp3 EBS root volume on every kata node (set in the EC2NodeClass).

RuntimeClasses (`kata-qemu`, `kata-clh`, `kata-fc`) are owned by the `kata` chart (`gitops/helm/kata`) rather than auto-generated, so all three are declared uniformly and carry pool-steering scheduling. Note `kata-fc`'s handler is `kata-fc-fc` (the `multiInstallSuffix`), but its RuntimeClass **name** stays `kata-fc`, so workloads are unaffected.

Host prep in `EC2NodeClass.userData`:
- All kata nodes load `kvm_intel` (creating `/dev/kvm`). On the nested pools, `cpuOptions.nestedVirtualization=enabled` first exposes Intel VT-x to the instance; the `.metal` pools have native VT-x so they omit `cpuOptions`.
- The **fc pools additionally build a devmapper thin-pool** and wire containerd's devmapper snapshotter — Firecracker requires a block snapshotter and cannot use overlayfs. kata-deploy-fc then registers `kata-fc` against it (`SNAPSHOTTER_HANDLER_MAPPING=kata-fc:devmapper`).

kata-deploy's generated config for firecracker under `multiInstallSuffix` sets both `image=` and `initrd=`, which fc rejects; this is corrected declaratively via `shims.fc.dropIn` in the kata-deploy-fc values (blanks `initrd`, keeping the stock image-based config). Bumping any Kata version is a one-line change to the relevant chart — no rebake.

## Teardown

```bash
cd scripts
./cleanup.sh   # terraform destroy
```
