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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$(cd "${SCRIPT_DIR}/../../terraform" && pwd)"

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

# ---------------- finance-ui-auth ----------------
# The finance-ui reads the Cognito app client secret + a session-signing
# secret from finance-ui-auth. The client secret is deterministic (from
# Terraform / Cognito); the session secret is generated once and preserved
# across re-runs so existing browser sessions aren't invalidated on redeploy.
echo "==> Ensuring finance-ui-auth secret"
CLIENT_SECRET=$(terraform -chdir="$TERRAFORM_DIR" output -raw finance_cognito_client_secret 2>/dev/null || true)
if [ -z "$CLIENT_SECRET" ]; then
  echo "ERROR: could not read finance_cognito_client_secret from terraform output."
  echo "Run scripts/install.sh (terraform apply) first."
  exit 1
fi
# Preserve an existing session-secret; only mint one on first install.
SESSION_SECRET=$(kubectl -n "$NS" get secret finance-ui-auth \
  -o jsonpath='{.data.session-secret}' 2>/dev/null | base64 -d || true)
[ -z "$SESSION_SECRET" ] && SESSION_SECRET=$(openssl rand -hex 32)
kubectl -n "$NS" create secret generic finance-ui-auth \
  --from-literal=cognito-client-secret="$CLIENT_SECRET" \
  --from-literal=session-secret="$SESSION_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

# ---------------- openclaw-gateway-auth ----------------
# Shared token between the session-router and the openclaw gateway. Generated
# once and preserved on re-runs (rotating it forces all sandboxes to restart).
echo "==> Ensuring openclaw-gateway-auth secret"
if ! kubectl -n "$NS" get secret openclaw-gateway-auth >/dev/null 2>&1; then
  kubectl -n "$NS" create secret generic openclaw-gateway-auth \
    --from-literal=token="$(openssl rand -hex 24)"
else
  echo "    openclaw-gateway-auth already exists — leaving as-is"
fi

# ---------------- session-router ----------------
# The session-router is not part of the ArgoCD sandbox app (its include list
# omits the session-router/ subdir), so render + apply it here. render.sh
# inlines server.js/package.json into the deployment ConfigMaps.
echo "==> Rendering + applying the session-router"
bash "${SCRIPT_DIR}/session-router/render.sh"
kubectl -n "$NS" apply -f "${SCRIPT_DIR}/session-router/k8s/deployment.rendered.yaml"
kubectl -n "$NS" apply -f "${SCRIPT_DIR}/session-router/k8s/reaper-cronjob.yaml"
kubectl -n "$NS" apply -f "${SCRIPT_DIR}/session-router/sandbox-template-configmap.yaml"

echo "==> Done. Commit the Argo Applications and ArgoCD will pick up the rest."
echo "   gitops/apps/finance-assistant.yaml already points at examples/finance-assistant."
