# Wave 0 — SSM parameter plan (DRAFT, not yet executed)
#
# Purpose: create a placeholder SSM parameter that Terraform can read during
# `terraform plan` even before the real Packer-baked AMI exists. This unblocks
# reviewing the Terraform diff without either of these being blockers:
#   - running Packer (costs money)
#   - running terraform apply (mutates cluster state)
#
# The parameter is consumed by:
#   - terraform/karpenter.tf.draft  → data "aws_ssm_parameter" "kata_ami_id"
#   - gitops/helm/kata-baked/values.yaml → kata.amiSSMParameter
#   - gitops/helm/kata-baked/templates/ec2nodeclass.yaml → amiSelectorTerms.ssmParameter
#
# WHEN TO RUN
# -----------
# Execute step 1 (create placeholder) BEFORE running `terraform plan` on the
# karpenter module. Execute step 2 (real update) AFTER Packer successfully
# publishes an AMI ID.
#
# Both steps are additive and reversible (aws ssm delete-parameter reverts).

# Step 1 — create placeholder (safe, run whenever)
aws ssm put-parameter \
  --name /openclaw/kata/ami-id \
  --type String \
  --value "ami-placeholder-will-be-overwritten-by-packer" \
  --description "Kata-baked AMI ID (populated by Packer pipeline). Wave 0 placeholder." \
  --region us-west-2 \
  --tags Key=Project,Value=openclaw Key=ManagedBy,Value=packer

# Step 2 — overwrite after Packer build (run from packer/ after `packer build .`)
#
# AMI_ID=$(aws ec2 describe-images \
#     --region us-west-2 \
#     --owners self \
#     --filters "Name=tag:ManagedBy,Values=packer" "Name=tag:Project,Values=openclaw" \
#     --query 'sort_by(Images, &CreationDate) | [-1].ImageId' \
#     --output text)
#
# aws ssm put-parameter \
#   --name /openclaw/kata/ami-id \
#   --type String \
#   --value "$AMI_ID" \
#   --region us-west-2 \
#   --overwrite

# ROLLBACK
# --------
# aws ssm delete-parameter --name /openclaw/kata/ami-id --region us-west-2
