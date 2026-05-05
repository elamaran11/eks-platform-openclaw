#!/usr/bin/env bash
# Provisions the finance-assistant namespace + LiteLLM API key secret.
#
# Uses the LiteLLM master key directly (read from the litellm-masterkey
# secret in the litellm namespace) rather than minting a per-app virtual
# key. Virtual keys live in LiteLLM's Postgres and are lost if the DB
# PVC is rebuilt — a failure mode we've hit repeatedly. The master key
# is env-sourced from a Terraform-managed secret and never goes stale.
#
# If you need per-app budget caps later, mint a virtual key and swap it
# in; the model lookup pattern is documented in LiteLLM docs.

set -euo pipefail

NS=finance-assistant
LITELLM_NS=litellm

echo "==> Reading LiteLLM master key from secret ${LITELLM_NS}/litellm-masterkey"
MASTER_KEY=$(kubectl -n "$LITELLM_NS" get secret litellm-masterkey \
  -o jsonpath='{.data.masterkey}' | base64 -d)
if [ -z "$MASTER_KEY" ]; then
  echo "ERROR: litellm-masterkey secret is missing or empty."
  echo "Run scripts/install.sh first to provision the LiteLLM stack."
  exit 1
fi

echo "==> Creating namespace + finance-litellm-key secret"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret generic finance-litellm-key \
  --from-literal=api-key="$MASTER_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Done. Commit the Argo Applications and ArgoCD will pick up the rest."
echo "   gitops/apps/finance-assistant.yaml already points at examples/finance-assistant."
