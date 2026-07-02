#!/usr/bin/env bash
# Benchmark sandbox startup time across all Kata VMMs and instance types.
#
# Runs the 6 combinations {kata-qemu, kata-clh, kata-fc} x {nested, metal} and,
# for each, measures two phases (matching the README "VMM startup benchmark"):
#   - Node Boot (cold): Karpenter NodeClaim created -> Ready
#       (EC2 boot + kata-deploy runtime install + startup-taint removal)
#   - 1st Pod (cold):   pod scheduled -> Ready on that fresh node
#       (VM boot + first, uncached image pull)
#   - 2nd Pod (warm):   a second pod scheduled -> Ready on the now-warm node
#       (pure VM boot, image cached)
#
# Each combination gets its OWN freshly-provisioned node: qemu and clh share a
# NodePool, so the shared pool is scaled to zero between them (by deleting the
# node-type's NodeClaims) to keep every cold-node figure independent.
#
# NOTE: kata-fc runs out of the box here. The image/initrd conflict from
# kata-deploy's multiInstallSuffix drop-in is fixed declaratively in the chart
# (gitops/helm/kata-deploy-fc/values.yaml -> shims.fc.dropIn), so NO on-node
# config patching is performed or required.
#
# COST WARNING: this provisions on-demand nodes including THREE bare-metal
# (.metal) instances. Requires a live cluster with the kata pools deployed.
#
# Usage:
#   ./scripts/benchmark-vmm-startup.sh                 # all 6 combos
#   ./scripts/benchmark-vmm-startup.sh --combos fc-nested,fc-metal
#   ./scripts/benchmark-vmm-startup.sh --yes           # skip confirmation

set -euo pipefail

NS=default
NODE_READY_TIMEOUT=420   # s to wait for a cold node's NodeClaim to go Ready (metal is slow)
POD_READY_TIMEOUT=300    # s to wait for a pod to reach Running
DRAIN_TIMEOUT=240        # s to wait for a pool's nodes to disappear after scale-to-zero
POLL=5

# combo -> "runtimeClassName node-type-label"
declare -A COMBOS=(
  [qemu-nested]="kata-qemu kata-nested"
  [clh-nested]="kata-clh  kata-nested"
  [fc-nested]="kata-fc    kata-fc"
  [qemu-metal]="kata-qemu kata-metal"
  [clh-metal]="kata-clh  kata-metal"
  [fc-metal]="kata-fc    kata-fc-metal"
)
ORDER=(qemu-nested clh-nested fc-nested qemu-metal clh-metal fc-metal)

# ---- args -------------------------------------------------------------------
ASSUME_YES=false
SELECTED=("${ORDER[@]}")
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=true; shift ;;
    --combos) IFS=',' read -r -a SELECTED <<< "$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/!s/^# \{0,1\}//p}' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }
kubectl get nodepools >/dev/null 2>&1 || { echo "no NodePools / cluster unreachable" >&2; exit 1; }

epoch() { date -d "$1" +%s 2>/dev/null || echo ""; }         # ISO8601 -> unix secs
now()   { date +%s; }

# scheduled/ready condition timestamps for a pod
pod_ts() { kubectl get pod "$1" -n "$NS" -o jsonpath="{range .status.conditions[?(@.type==\"$2\")]}{.lastTransitionTime}{end}" 2>/dev/null; }

wait_pod_running() {
  local pod=$1 deadline=$(( $(now) + POD_READY_TIMEOUT ))
  while [ "$(now)" -lt "$deadline" ]; do
    local phase; phase=$(kubectl get pod "$pod" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [ "$phase" = "Running" ] && return 0
    [ "$phase" = "Failed" ] && { echo "  ! $pod Failed"; return 1; }
    sleep "$POLL"
  done
  echo "  ! timeout waiting for $pod (last: $(kubectl get pod "$pod" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null))"
  kubectl describe pod "$pod" -n "$NS" 2>/dev/null | grep -A3 Events: | tail -3
  return 1
}

# scale a node-type's pool to zero: delete matching NodeClaims, wait for nodes gone
drain_nodetype() {
  local nt=$1
  local ncs
  ncs=$(kubectl get nodeclaims -o json | jq -r ".items[] | select(.metadata.labels[\"node-type\"]==\"$nt\") | .metadata.name")
  [ -n "$ncs" ] && kubectl delete nodeclaim $ncs --wait=false >/dev/null 2>&1 || true
  local deadline=$(( $(now) + DRAIN_TIMEOUT ))
  while [ "$(now)" -lt "$deadline" ]; do
    local n; n=$(kubectl get nodes -l "node-type=$nt" --no-headers 2>/dev/null | wc -l)
    [ "$n" -eq 0 ] && return 0
    sleep "$POLL"
  done
  echo "  ~ warn: $nt nodes still present after drain timeout (continuing)"
}

# NodeClaim boot time for the node a pod landed on
node_boot_secs() {
  local node=$1
  local nc created ready
  nc=$(kubectl get nodeclaims -o json | jq -r ".items[] | select(.status.nodeName==\"$node\") | .metadata.name" | head -1)
  [ -z "$nc" ] && { echo ""; return; }
  created=$(kubectl get nodeclaim "$nc" -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null)
  ready=$(kubectl get nodeclaim "$nc" -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.lastTransitionTime}{end}' 2>/dev/null)
  local c r; c=$(epoch "$created"); r=$(epoch "$ready")
  [ -n "$c" ] && [ -n "$r" ] && echo $(( r - c )) || echo ""
}

launch_pod() {  # name runtimeclass node-type
  local name=$1 rc=$2 nt=$3
  kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $name
  namespace: $NS
  labels: { bench: vmm-startup }
spec:
  runtimeClassName: $rc
  nodeSelector: { node-type: $nt }
  restartPolicy: Never
  containers:
    - name: c
      image: busybox:1.36
      command: ["sh","-c","uname -r; sleep 3600"]
      resources:
        requests: { cpu: "500m", memory: 256Mi }
EOF
}

cleanup_pods() { kubectl delete pods -l bench=vmm-startup -n "$NS" --force --grace-period=0 >/dev/null 2>&1 || true; }

# ---- confirm ----------------------------------------------------------------
echo "Combinations to run: ${SELECTED[*]}"
echo "This provisions cold on-demand nodes (incl. bare-metal for *-metal). Real AWS cost."
if [ "$ASSUME_YES" != true ]; then
  read -r -p "Proceed? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted"; exit 0; }
fi

trap cleanup_pods EXIT
declare -A R_NODE R_POD1 R_POD2   # results per combo

# ---- run --------------------------------------------------------------------
for combo in "${SELECTED[@]}"; do
  spec=${COMBOS[$combo]:-}
  [ -z "$spec" ] && { echo "skip unknown combo: $combo"; continue; }
  read -r rc nt <<< "$spec"
  echo
  echo "=== $combo  (runtimeClass=$rc node-type=$nt) ==="

  cleanup_pods
  echo "  scaling $nt pool to zero for a cold node..."
  drain_nodetype "$nt"

  # phase 1: cold node + 1st pod
  echo "  launching 1st (cold) pod..."
  launch_pod "bench-$combo-1" "$rc" "$nt"
  if wait_pod_running "bench-$combo-1"; then
    node=$(kubectl get pod "bench-$combo-1" -n "$NS" -o jsonpath='{.spec.nodeName}')
    R_NODE[$combo]=$(node_boot_secs "$node"); R_NODE[$combo]=${R_NODE[$combo]:-?}
    s=$(epoch "$(pod_ts bench-$combo-1 PodScheduled)"); r=$(epoch "$(pod_ts bench-$combo-1 Ready)")
    R_POD1[$combo]=$([ -n "$s" ] && [ -n "$r" ] && echo $(( r - s )) || echo "?")
    echo "  node=$node  NodeBoot=${R_NODE[$combo]}s  1stPod=${R_POD1[$combo]}s"
  else
    R_NODE[$combo]="FAIL"; R_POD1[$combo]="FAIL"
  fi

  # phase 2: warm 2nd pod on the same node
  if [ "${R_POD1[$combo]}" != "FAIL" ]; then
    echo "  launching 2nd (warm) pod..."
    launch_pod "bench-$combo-2" "$rc" "$nt"
    if wait_pod_running "bench-$combo-2"; then
      s=$(epoch "$(pod_ts bench-$combo-2 PodScheduled)"); r=$(epoch "$(pod_ts bench-$combo-2 Ready)")
      R_POD2[$combo]=$([ -n "$s" ] && [ -n "$r" ] && echo $(( r - s )) || echo "?")
      echo "  2ndPod(warm)=${R_POD2[$combo]}s"
    else
      R_POD2[$combo]="FAIL"
    fi
  else
    R_POD2[$combo]="-"
  fi
done

# ---- report -----------------------------------------------------------------
echo
echo "===================== RESULTS ====================="
printf '| %-10s | %-14s | %-9s | %-8s | %-10s | %-9s |\n' VMM Instance "NodeBoot" "1stPod" "ColdTotal" "2ndPod"
printf '|%s|%s|%s|%s|%s|%s|\n' "------------" "----------------" "-----------" "----------" "------------" "-----------"
for combo in "${SELECTED[@]}"; do
  [ -z "${COMBOS[$combo]:-}" ] && continue
  read -r rc nt <<< "${COMBOS[$combo]}"
  nb=${R_NODE[$combo]:-?}; p1=${R_POD1[$combo]:-?}; p2=${R_POD2[$combo]:-?}
  total="?"; [[ "$nb" =~ ^[0-9]+$ && "$p1" =~ ^[0-9]+$ ]] && total=$(( nb + p1 ))
  printf '| %-10s | %-14s | %7ss | %6ss | %8ss | %6ss |\n' "$rc" "$nt" "$nb" "$p1" "$total" "$p2"
done
echo "==================================================="
echo "(NodeBoot=cold NodeClaim created->Ready; 1stPod=cold scheduled->Ready;"
echo " ColdTotal=NodeBoot+1stPod; 2ndPod=warm scheduled->Ready on existing node)"
