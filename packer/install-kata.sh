#!/usr/bin/env bash
set -euxo pipefail

echo ">>> Installing Kata Containers with Cloud Hypervisor default (AL2023, bare metal)"

# 0. Grow root partition to use full disk
sudo growpart /dev/nvme0n1 1 || sudo growpart /dev/xvda 1 || true
sudo xfs_growfs / || sudo resize2fs /dev/nvme0n1p1 || sudo resize2fs /dev/xvda1 || true
df -h /

# 1. Install deps
sudo dnf install -y jq tar gzip zstd

# 2. Auto-load KVM modules (bare metal exposes VT-x directly)
cat <<EOF | sudo tee /etc/modules-load.d/kvm.conf
kvm
kvm_intel
kvm_amd
EOF

# 3. Download and install Kata static release
KATA_VERSION="${KATA_VERSION:-3.27.0}"
WORKDIR="$HOME/kata-install"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

curl -fSL --retry 3 --retry-delay 5 -o kata-static.tar.zst \
    "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-static-${KATA_VERSION}-amd64.tar.zst"

FILESIZE=$(stat -c%s kata-static.tar.zst)
if [ "$FILESIZE" -lt 100000000 ]; then
    echo "ERROR: kata-static tarball too small (${FILESIZE} bytes), likely corrupted"
    exit 1
fi

zstd -d -f kata-static.tar.zst -o kata-static.tar
echo ">>> Extracting kata-static.tar (quiet — ~40k files)..."
sudo tar -xf kata-static.tar -C /
sudo sync
echo ">>> Extraction done."

# Sanity check
ls -la /opt/kata/bin/
SHIM_SIZE=$(stat -c%s /opt/kata/bin/containerd-shim-kata-v2)
if [ "$SHIM_SIZE" -eq 0 ]; then
    echo "ERROR: containerd-shim-kata-v2 is 0 bytes — extraction failed"
    exit 1
fi
/opt/kata/bin/kata-runtime --version

cd /
rm -rf "$WORKDIR"

sudo ln -sf /opt/kata/bin/kata-runtime /usr/local/bin/kata-runtime
sudo ln -sf /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2

# 4. Default config = Cloud Hypervisor (OpenClaw's preferred hypervisor)
sudo mkdir -p /etc/kata-containers
sudo cp /opt/kata/share/defaults/kata-containers/configuration-clh.toml \
    /etc/kata-containers/configuration.toml
sudo ln -sf /etc/kata-containers/configuration.toml \
    /etc/kata-containers/configuration-clh.toml

# Also ship QEMU config so both runtimes are available
sudo cp /opt/kata/share/defaults/kata-containers/configuration-qemu.toml \
    /etc/kata-containers/configuration-qemu.toml

# 5. Bake containerd runtime handlers into /etc/eks/nodeadm.d/
#    Per AWS docs (eks/latest/userguide/al2023.html — "Additional Information
#    About nodeadm"), this is the correct pattern for AL2023 custom AMIs:
#    nodeadm-config / nodeadm-run systemd services merge YAML files in
#    /etc/eks/nodeadm.d/ with userData atomically at boot — avoiding the
#    double-nodeadm-init race that otherwise misconfigures ENIs and triggers
#    an uncontrolled reboot (empirically observed 2026-04-22 with userData-
#    delivered NodeConfig on c5.metal MNG).
sudo mkdir -p /etc/eks/nodeadm.d
sudo tee /etc/eks/nodeadm.d/50-kata-containerd.yaml > /dev/null <<'NODECFG'
apiVersion: node.eks.aws/v1alpha1
kind: NodeConfig
spec:
  containerd:
    config: |
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh]
      runtime_type = "io.containerd.kata.v2"
      privileged_without_host_devices = true
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh.options]
      ConfigPath = "/etc/kata-containers/configuration.toml"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
      runtime_type = "io.containerd.kata.v2"
      privileged_without_host_devices = true
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu.options]
      ConfigPath = "/etc/kata-containers/configuration-qemu.toml"
NODECFG

# 6. Verification helper for operator use
cat <<'EOF' | sudo tee /usr/local/bin/verify-kata.sh
#!/bin/bash
echo "=== KVM Check ==="
ls -la /dev/kvm 2>/dev/null || echo "KVM not available"
lsmod | grep kvm || echo "KVM modules not loaded"

echo ""
echo "=== Kata Version ==="
/opt/kata/bin/kata-runtime --version

echo ""
echo "=== Containerd runtime handlers ==="
grep -A5 kata /etc/containerd/config.toml || echo "containerd config not yet rendered"
EOF
sudo chmod +x /usr/local/bin/verify-kata.sh

# CRITICAL: flush page cache before Packer stops the instance
# (~4.7GB Kata release in page cache — without this, AMI gets 0-byte files)
sync
sleep 5
sync

echo ">>> Kata install complete."
