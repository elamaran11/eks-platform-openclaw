# IAM role for LiteLLM pod to call Bedrock via Pod Identity
resource "aws_iam_role" "litellm_bedrock" {
  name = "${local.cluster_name}-litellm-bedrock"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "pods.eks.amazonaws.com"
      }
      Action = [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "litellm_bedrock" {
  name = "bedrock-invoke"
  role = aws_iam_role.litellm_bedrock.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:ApplyGuardrail"
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
          aws_bedrock_guardrail.openclaw.guardrail_arn
        ]
      }
    ]
  })
}

# Pod Identity association: litellm service account -> Bedrock role
resource "aws_eks_pod_identity_association" "litellm" {
  cluster_name    = module.eks.cluster_name
  namespace       = "litellm"
  service_account = "litellm"
  role_arn        = aws_iam_role.litellm_bedrock.arn

  tags = local.tags
}
