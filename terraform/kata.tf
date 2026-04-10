# NodeClass stays in Terraform — it needs module.eks.node_iam_role_name at apply time.
# NodePool and RuntimeClass are in gitops/helm/kata/ (managed by ArgoCD).

resource "kubectl_manifest" "kata_nodeclass" {
  count = var.enable_kata_nodes ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: eks.amazonaws.com/v1
    kind: NodeClass
    metadata:
      name: kata-bare-metal
    spec:
      role: "${module.eks.node_iam_role_name}"
      subnetSelectorTerms:
        - tags:
            karpenter.sh/discovery: "${local.cluster_name}"
      securityGroupSelectorTerms:
        - tags:
            karpenter.sh/discovery: "${local.cluster_name}"
      amiSelectorTerms:
        - alias: al2023@latest
      ephemeralStorage:
        size: "200Gi"
        iops: 3000
        throughput: 125
      userData: |
        #!/bin/bash
        set -euo pipefail

        dnf install -y lvm2 kata-containers

        NVME_DEVICES=$(lsblk -dpno NAME,TYPE | awk '$2=="disk" && $1~/nvme/ {print $1}' | sort)
        DEVICE_COUNT=$(echo "$NVME_DEVICES" | wc -l)

        if [ "$DEVICE_COUNT" -gt 1 ]; then
          dnf install -y mdadm
          mdadm --create /dev/md0 --level=0 --raid-devices="$DEVICE_COUNT" $NVME_DEVICES
          BLOCK_DEVICE=/dev/md0
        else
          BLOCK_DEVICE=$(echo "$NVME_DEVICES" | head -1)
        fi

        pvcreate "$BLOCK_DEVICE"
        vgcreate containerd-vg "$BLOCK_DEVICE"
        lvcreate --wipesignatures y -n thinpool containerd-vg -l 95%VG
        lvcreate --wipesignatures y -n thinpoolmeta containerd-vg -l 1%VG
        lvconvert -y --zero n -c 512K \
          --thinpool containerd-vg/thinpool \
          --poolmetadata containerd-vg/thinpoolmeta

        cat > /etc/lvm/profile/containerd-vg-thinpool.profile <<'LVMEOF'
        activation {
          thin_pool_autoextend_threshold=80
          thin_pool_autoextend_percent=20
        }
        LVMEOF
        lvchange --metadataprofile containerd-vg-thinpool containerd-vg/thinpool

        mkdir -p /etc/containerd/conf.d
        cat > /etc/containerd/conf.d/kata.toml <<'CTREOF'
        [plugins."io.containerd.grpc.v1.cri".containerd]
          snapshotter = "devmapper"

        [plugins."io.containerd.snapshotter.v1.devmapper"]
          pool_name = "containerd-vg-thinpool"
          root_path = "/var/lib/containerd/io.containerd.snapshotter.v1.devmapper"
          base_image_size = "10GB"
          discard_blocks = true

        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu.options]
            ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"
        CTREOF

        systemctl restart containerd
  YAML

  depends_on = [module.eks]
}
