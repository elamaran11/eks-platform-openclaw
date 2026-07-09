# Per-user session router (thin shim over agent-sandbox CRDs)

A thin, tenant-aware shim. It no longer applies static templated manifests
or manages Sandboxes/PVCs/Services directly. It owns exactly two jobs:

1. **Provisioning** — create one declarative `SandboxClaim` per
   authenticated Cognito user. The agent-sandbox controller (v0.5.0) binds
   the claim to a pre-warmed sandbox from the `SandboxWarmPool` (fast) or
   cold-creates one (empty pool).
2. **Proxying** — stream the `/chat` SSE from the bound sandbox's adapter,
   passing the user's suffix so the sandbox routes to that user's dedicated
   openclaw agent + `/workspace/users/<suffix>` subdir.

Per-user isolation is now enforced inside the pod by openclaw's dynamic
multi-agent feature (see `../adapter/`), not by a per-user PVC. A single
shared RWX EFS volume is mounted in every warm pod; each user's files live
in their own subdir, which survives claim teardown.

## Components

| Path | Role |
|---|---|
| `server.js` | Reads `x-amzn-oidc-data` (JWT signed by the ALB after Cognito auth), hashes `sub` → 10-char suffix, get-or-creates `finance-claim-<suffix>`, waits for the claim to bind + Ready, reads the bound `Sandbox.status.serviceFQDN`, proxies the SSE chat stream (injecting the suffix in the body), and renews the sliding idle lease on each message. |
| `package.json` | `@kubernetes/client-node` only. No LLM/aws-sdk dependencies — router never talks to Bedrock or reads secrets. |
| `k8s/deployment.yaml` | Router Deployment + Service + SA + Role (`sandboxclaims` CRUD + `sandboxes` get/list, in-namespace only). Two replicas. |
| `render.sh` | Inlines `server.js` + `package.json` into the two ConfigMaps → `k8s/deployment.rendered.yaml`. |

The `SandboxTemplate`, `SandboxWarmPool`, and shared EFS PVC live in
`../sandbox-template.yaml` (applied by ArgoCD, not this router).

## Trust and isolation invariants

- Router is the only tenant-aware Kubernetes process. Holds **no LLM key, no Bedrock creds**.
- Router's RBAC is scoped to `sandboxclaims` (CRUD) + `sandboxes` (read) in one namespace. No secrets access, no pod/exec, no Services/PVCs, no cluster scope.
- Each user gets their own kata-qemu VM (one sandbox per claim); inside it, a dedicated openclaw agent rooted at `/workspace/users/<suffix>`.
- NetworkPolicy: only the router can reach a bound sandbox on :18790 (keyed on the `sandbox.users.io/user-suffix` label the claim stamps via `additionalPodMetadata`). Direct UI→sandbox blocked.
- The claim's `sub-hash` annotation stores a **hash** of the sub, not the sub itself — debuggable without PII.

## Request flow

```
browser
  → ALB (Cognito auth, signs x-amzn-oidc-data)
  → finance-ui (ROUTER_URL=finance-session-router:18790)
  → finance-session-router  ← holds no secrets, narrow RBAC
       ├─ get-or-create SandboxClaim/finance-claim-<suffix>
       ├─ wait bound + Ready (heartbeat SSE), read serviceFQDN
       ├─ renew lifecycle.shutdownTime = now + IDLE_TTL (sliding lease)
       └─ proxy /chat to <serviceFQDN>:18790 (suffix in body)
  → kata-qemu VM (warm-bound)
  → adapter: openclaw agents add / agent --agent pod-agent-<suffix>
  → openclaw gateway → LiteLLM → Bedrock
```

## Idle teardown

The claim's `spec.lifecycle` handles it: `shutdownPolicy: Delete` +
a sliding `shutdownTime` the router pushes to `now + IDLE_TTL_SECONDS`
(default 1800s) on every message. When the lease expires the controller
deletes the bound Sandbox; the warm buffer (`replicas: 1`) is untouched.
Shared EFS state lives outside the lifecycle, so user files survive. This
replaces the old `reaper-cronjob.yaml`.

## Build / deploy

```
cd examples/finance-assistant/session-router
./render.sh
kubectl apply -f k8s/deployment.rendered.yaml
```

The `SandboxTemplate`/`SandboxWarmPool`/EFS PVC are applied by ArgoCD
(`gitops/apps/finance-assistant.yaml` include list).

## Known follow-ups

- **True token streaming** — the adapter still shells `openclaw agent --json` and emits the whole reply as one SSE delta. A WebSocket client to the gateway (`chat.send` / `deltaText`) would stream per-token. Tier-2.
- **Image-baked router** instead of `npm install` at container start; the ConfigMap pattern matches the adapter, but a purpose-built image is faster and more auditable.
- **JWKS verification** inside the router in case the ALB auth is ever removed; we currently trust `x-amzn-oidc-data` because the ALB signs it before forwarding.
