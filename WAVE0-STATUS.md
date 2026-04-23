# Status — Kata path migration (additive)

**Last updated after:** Wave 2 applied and verified.

## What's live in the cluster right now

| Thing | State |
|---|---|
| Old MNG `openclaw-eks-kata` (kata-deploy DaemonSet, QEMU) | Running, untouched, workloads still on it |
| New MNG `openclaw-eks-kata-baked` (Packer AMI, CLH) | **Running** on `ip-10-0-25-98` |
| `finance-assistant/finance-assistant` pod | Running on old node, `runtimeClassName: kata-qemu` |
| `openclaw/openclaw-slack-sandbox` pod | Running on old node, `runtimeClassName: kata-qemu` |
| `kata-kubelet-restart` DaemonSet | Excludes baked-ami nodes via nodeAffinity |
| ArgoCD `kata-deploy` Application | **Autosync temporarily disabled** — re-enable after pushing |

## Wave 2 smoke-test result

Fresh baked-ami node, CLH microVM pod verified:

```
Host (bare metal AL2023): kernel 6.1.166-197.305.amzn2023.x86_64
Guest (Kata microVM):     kernel 6.18.12
```

Different kernels ⇒ real VM boundary via Cloud Hypervisor. No kata-deploy,
no containerd restart, no kubelet-restart dance — the baked AMI did all the
setup at image build time, and nodeadm userData registered the runtime
handlers before containerd started.

## Key architectural state

```
terraform/kata.tf         — original MNG + kata-deploy path (unchanged)
terraform/kata_baked.tf   — new MNG + Packer AMI + launch template (added)
terraform/variables.tf    — added enable_kata_baked (default true)
packer/                   — AMI pipeline; AMI ami-0a9d081a8aaf7c0b5 in SSM
gitops/helm/kata-deploy/templates/kubelet-restart.yaml — affinity excludes
                             kata-path=baked-ami so the DS skips new nodes
```

## Isolation guarantees

| | Old MNG | New MNG |
|---|---|---|
| Label | `katacontainers.io/kata-runtime=true` | `katacontainers.io/kata-runtime=true` + `kata-path=baked-ami` |
| Taint | `kata=true:NoSchedule` | `kata-baked=true:NoSchedule` (distinct) |
| RuntimeClass used | `kata-qemu` (default) | `kata-clh` (once migrated) |
| CNI | aws-node (scheduled by `kata-runtime` label) | aws-node (same label, so it schedules) |
| kata-deploy DS | Running | Does NOT land (tolerates `kata`, not `kata-baked`) |
| kata-kubelet-restart DS | Running | Does NOT land (nodeAffinity excludes `baked-ami`) |

## Not done yet (Wave 3 — future, explicit decision)

- Migrate `finance-assistant` and `openclaw-slack-sandbox` onto the baked pool
- Delete `gitops/helm/kata-deploy/` and `gitops/apps/kata-deploy.yaml`
- Delete the old `aws_eks_node_group.kata` and its launch-time kube-proxy patch
- Rename `kata-path=baked-ami` → just `katacontainers.io/kata-runtime=true`
  (or adjust depending on Wave 3 plan)

Wave 3 requires a brief pod restart for the two workloads. Deferred by user
decision to not impact them in this session.

## Branch

`feature/karpenter-baked-ami-kata` — main is NOT touched.
