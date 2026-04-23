# Status — Kata path migration (additive)

**Last updated:** Wave 2 fixed and verified end-to-end 2026-04-23.

## What's live in the cluster right now

| Thing | State |
|---|---|
| Old MNG `openclaw-eks-kata` | Running on `ip-10-0-44-9`, kata-deploy + QEMU path |
| **New MNG `openclaw-eks-kata-baked`** | **Running on `ip-10-0-40-239`, baked AMI + CLH path** |
| `finance-assistant/finance-assistant` pod | Running on old node, `runtimeClassName: kata-qemu` — untouched |
| `openclaw/openclaw-slack-sandbox` pod | Running on old node, `runtimeClassName: kata-qemu` — untouched |
| `aws-node` DaemonSet | Running on both Kata nodes ✅ |
| `kata-deploy` DaemonSet | Running on old node only (tolerates `kata`, not `kata-baked`) ✅ |
| `kata-kubelet-restart` DaemonSet | Running on old node only (nodeAffinity excludes `kata-path=baked-ami`) ✅ |

## Wave 2 end-to-end verification

```
Host kernel (AL2023 base):       6.1.166-197.305.amzn2023.x86_64
Guest kernel (Kata + CLH):       6.18.12
```

Different kernels = real Cloud Hypervisor microVM boundary. Node stable 16+ min
(previously rebooted at T+3:45 with old userData). No containerd restart, no
kata-deploy DaemonSet touched, no kubelet restart dance.

## Root cause of the previous failure

Passing BOTH cluster-join info AND containerd.config via userData on an AL2023
custom AMI triggered a double-nodeadm-init race: ENA driver misconfigured at
T+3:45, clean `systemctl reboot`, instance then permanently impaired.

Per AWS docs (eks/latest/userguide/al2023.html → "Additional Information About
nodeadm"): on AL2023 the correct pattern is

- Drop `NodeConfig` YAML into `/etc/eks/nodeadm.d/` **at AMI bake time**
- Pass **only cluster-join info** via userData

`nodeadm-config` systemd service merges them before `nodeadm-run`.

## Current artifacts

| | Value |
|---|---|
| Packer AMI (v3) | `ami-0806011946a1702fb` |
| SSM parameter | `/openclaw/kata/ami-id = ami-0806011946a1702fb` (version 3) |
| Node group | `openclaw-eks-kata-baked` |
| Launch template | `lt-05a983402cec83ce1` |
| Terraform flag | `var.enable_kata_baked = true` (default) |

## Key architectural state

```
packer/install-kata.sh            bakes /etc/eks/nodeadm.d/50-kata-containerd.yaml
                                  into AMI with kata-clh + kata-qemu handlers

terraform/kata.tf                 original MNG (unchanged, kata-deploy path)

terraform/kata_baked.tf           new additive MNG, minimal userData
                                  (cluster-join only), references SSM AMI

gitops/helm/kata-deploy/templates/
  kubelet-restart.yaml            nodeAffinity excludes kata-path=baked-ami
                                  so DS doesn't brick baked nodes
```

## Isolation guarantees (verified in cluster)

| | Old MNG | New MNG |
|---|---|---|
| Label | `katacontainers.io/kata-runtime=true` | same + `kata-path=baked-ami` |
| Taint | `kata=true:NoSchedule` | `kata-baked=true:NoSchedule` |
| Default RuntimeClass | `kata-qemu` | `kata-clh` (from smoke test) |
| CNI | aws-node scheduled (common label) | aws-node scheduled ✅ |
| kata-deploy DS | runs here | doesn't land (taint mismatch) ✅ |
| kata-kubelet-restart DS | runs here | doesn't land (nodeAffinity) ✅ |

## Not done yet (Wave 3 — future, explicit decision)

- Migrate `finance-assistant` and `openclaw-slack-sandbox` onto the baked pool
- Delete `gitops/helm/kata-deploy/` and `gitops/apps/kata-deploy.yaml`
- Delete the old `aws_eks_node_group.kata` and its kube-proxy null_resource
- Optionally rename `kata-path=baked-ami` / taint `kata-baked=true` back to
  the canonical `kata` names after old MNG retired

Wave 3 requires a brief pod restart for both workloads. Deferred by user
decision to not impact them in this session.

## Branch

`feature/karpenter-baked-ami-kata` — main is NOT touched.

Commits on this branch:
  0a5f75f  wave 0: drafts
  688a4a1  wave 1: Packer AMI + karpenter.tf promoted (later reverted)
  991f68a  wave 1b/2: revert Karpenter, draft MNG path
  3ba589b  wave 2: additive MNG (first attempt, failed with reboot loop)
  8141942  wave 2 fix: split NodeConfig per AWS docs — PRODUCTION STATE

Ready for PR review whenever you want to merge.
