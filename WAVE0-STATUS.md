# Wave 0 — local files created, not applied
#
# Nothing in this directory tree has touched `openclaw-eks`. Every file is
# either in Git or .draft / .sh extensions (ignored by ArgoCD).
#
# Files produced in Wave 0
# -------------------------
# packer/kata-ami.pkr.hcl                              — Packer template (metal-only, CLH default)
# packer/install-kata.sh                               — Installer run during AMI build
# packer/ssm-parameter-plan.sh                         — Commands to populate /openclaw/kata/ami-id
# terraform/karpenter.tf.draft                         — Karpenter IAM/SQS/Pod Identity (not applied)
# gitops/helm/karpenter/                               — Helm chart wrapping upstream Karpenter
# gitops/helm/kata-baked/                              — NodePool + EC2NodeClass + isolated RuntimeClass
# gitops/apps/karpenter.yaml.draft                     — ArgoCD App (automated sync OFF)
# gitops/apps/kata-baked.yaml.draft                    — ArgoCD App (automated sync OFF)
#
# What did NOT change
# -------------------
# - terraform/eks.tf                 (Auto Mode + Kata MNG untouched)
# - terraform/kata.tf                (existing Kata MNG + kube-proxy patch intact)
# - gitops/helm/kata/                (existing RuntimeClass chart untouched)
# - gitops/helm/kata-deploy/         (kata-deploy DaemonSet chart untouched)
# - gitops/apps/kata.yaml            (still syncing)
# - gitops/apps/kata-deploy.yaml     (still syncing)
# - Any running workload, DaemonSet, RuntimeClass, or node on the cluster
#
# Isolation from existing Kata path
# ---------------------------------
# | Dimension        | Existing path              | Wave 0 baked path           |
# |------------------|----------------------------|-----------------------------|
# | Node label       | katacontainers.io/kata-... | kata-pool=baked-clh         |
# | Taint            | kata=true:NoSchedule       | kata-baked=true:NoSchedule  |
# | RuntimeClass     | kata-qemu / kata-clh       | kata-clh-baked              |
# | Install path     | kata-deploy DaemonSet      | Packer AMI + nodeadm        |
# | Node provisioner | EKS Managed Node Group     | Karpenter                   |
# | Applied today?   | YES (running)              | NO (drafts only)            |
#
# Next steps (require user go-ahead — NOT done automatically)
# -----------------------------------------------------------
# 1. Run packer/ssm-parameter-plan.sh step 1 (create SSM placeholder)
# 2. `cd packer && packer init . && packer build .`  (~20 min, ~$0.40 for c5.metal)
# 3. After successful build, run step 2 of ssm-parameter-plan.sh to publish the real AMI ID
# 4. `mv terraform/karpenter.tf.draft terraform/karpenter.tf && terraform plan`  (review diff)
# 5. `terraform apply`  (creates IAM role, SQS, Pod Identity — still no cluster-side change)
# 6. `mv gitops/apps/karpenter.yaml.draft gitops/apps/karpenter.yaml` + enable automated sync
# 7. After Karpenter controller Running for 24h with no NodePools:
#    `mv gitops/apps/kata-baked.yaml.draft gitops/apps/kata-baked.yaml` + enable automated sync
# 8. Launch smoke-test pod that tolerates kata-baked taint + selects kata-pool=baked-clh
