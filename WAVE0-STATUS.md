# Wave status — metal-only Kata via baked AMI + MNG

## Pivot rationale

Wave 0/1 aimed for Karpenter + baked AMI. Blocker discovered at apply verification:

> AWS EKS Auto Mode **does not accept custom AMIs** — the service determines the
> OS and image. Source: https://docs.aws.amazon.com/eks/latest/userguide/automode-learn-instances.html

Since Auto Mode's embedded Karpenter was already reconciling cluster NodePools
(`general-purpose`, `system`, plus the Kata `kata-bare-metal-nxfcb` NodeClaim
from an earlier experiment), installing a second user-managed Karpenter would
create a split-brain CRD race. AWS documents no supported way to run Auto Mode
+ user Karpenter side-by-side.

**Decision:** keep EKS Managed Node Group (proven on this cluster) but replace
the kata-deploy DaemonSet path with a Packer-baked AMI + nodeadm userData.

## What stayed from earlier waves

- `packer/kata-ami.pkr.hcl`, `packer/install-kata.sh` — metal-only builder
- `packer/ssm-parameter-plan.sh`
- AMI `ami-0a9d081a8aaf7c0b5` (live in account 940019131157, us-west-2)
- SSM `/openclaw/kata/ami-id` = `ami-0a9d081a8aaf7c0b5` (version 2)

## What was reverted

- `terraform destroy -target=module.karpenter` — 23 resources removed cleanly
- `terraform/karpenter.tf` — deleted
- `gitops/helm/karpenter/` — deleted
- `gitops/helm/kata-baked/` — deleted
- `gitops/apps/karpenter.yaml.draft`, `gitops/apps/kata-baked.yaml.draft` — deleted

## What's new (Wave 2 draft, NOT applied)

- `terraform/kata.tf.wave2-draft` — replaces the existing `terraform/kata.tf`
  - Adds `data "aws_ssm_parameter" "kata_ami_id"` reading from SSM
  - Adds `aws_launch_template.kata` with `image_id` from SSM
  - MIME-multipart userData containing nodeadm `NodeConfig`:
      - `spec.cluster.*` — cluster name, endpoint, CA, service CIDR (so node
        can join without EKS-injected bootstrap — required when `ami_type=CUSTOM`)
      - `spec.containerd.config` — registers `kata-clh` and `kata-qemu`
        runtime handlers BEFORE containerd starts (no restart)
  - `aws_eks_node_group.kata`:
      - `ami_type = "CUSTOM"` (was `AL2023_x86_64_STANDARD`)
      - `launch_template { id, version }` attached
      - Same labels, taints, subnets, scaling, IAM, access entry
  - `null_resource.kube_proxy_kata_affinity` retained — still required
    (Auto Mode kube-proxy DaemonSet targets `compute-type=auto` only; MNG
    nodes need the patch regardless of how Kata is installed)

## What this replaces once promoted and applied

| Artifact today | After Wave 2 |
|---|---|
| `gitops/helm/kata-deploy/` (Helm wrapper around DaemonSet) | Deleted — binaries in AMI |
| `gitops/apps/kata-deploy.yaml` (ArgoCD Application) | Deleted |
| `gitops/helm/kata-deploy/templates/kubelet-restart.yaml` | Deleted — no containerd restart |
| kata-deploy DaemonSet pulling quay.io image at every node boot | — |
| kata-kubelet-restart DaemonSet | — |
| Node Ready in 3–5 min | Node Ready in ~60–90 s |

## Verification before promoting kata.tf.wave2-draft → kata.tf

1. Confirm `module.eks.cluster_service_cidr` is an exposed output of the
   `terraform-aws-modules/eks/aws ~> 20.0` version in use (it is for 20.x, but
   verify with `terraform console` or a targeted plan before apply).
2. `mv terraform/kata.tf.wave2-draft terraform/kata.tf`
3. `terraform plan -target=aws_launch_template.kata -target=aws_eks_node_group.kata`
   — expect: create LT, in-place replace MNG (new ami_type + launch_template).
4. Decide whether to `-replace` the existing Kata node or let MNG rolling-update
   handle it.

## Current branch state

Branch `feature/karpenter-baked-ami-kata`:
  0a5f75f  wave 0: drafts
  688a4a1  wave 1: Packer AMI + karpenter.tf promoted (now reverted)
  HEAD     wave 1b/2: cleanup + kata.tf.wave2-draft

main: UNTOUCHED.
