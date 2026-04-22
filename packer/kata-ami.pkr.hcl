packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "cluster_name" {
  type    = string
  default = "openclaw-eks"
}

variable "kubernetes_version" {
  type        = string
  default     = "1.32"
  description = "EKS Kubernetes version — must match the cluster"
}

variable "kata_version" {
  type    = string
  default = "3.27.0"
}

variable "build_instance_type" {
  type        = string
  default     = "c5.metal"
  description = "Bare-metal builder — OpenClaw is metal-only"
}

variable "vpc_id" {
  type        = string
  default     = ""
  description = "VPC for the builder. Empty = default VPC."
}

variable "subnet_id" {
  type        = string
  default     = ""
  description = "Public subnet for the builder. Empty = Packer picks one."
}

source "amazon-ebs" "kata_baremetal" {
  ami_name      = "${var.cluster_name}-kata-al2023-baremetal-{{timestamp}}"
  instance_type = var.build_instance_type
  region        = var.aws_region

  source_ami_filter {
    filters = {
      name                = "amazon-eks-node-al2023-x86_64-standard-${var.kubernetes_version}-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["602401143452"] # Amazon EKS AMI account
  }

  vpc_id                      = var.vpc_id != "" ? var.vpc_id : null
  subnet_id                   = var.subnet_id != "" ? var.subnet_id : null
  associate_public_ip_address = true
  ssh_username                = "ec2-user"

  aws_polling {
    delay_seconds = 30
    max_attempts  = 60
  }

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 250
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name               = "${var.cluster_name}-kata-al2023-baremetal"
    KataVersion        = var.kata_version
    KubernetesVersion  = var.kubernetes_version
    BuildInstanceType  = var.build_instance_type
    VirtualizationMode = "baremetal"
    ManagedBy          = "packer"
    Project            = "openclaw"
  }
}

build {
  sources = ["source.amazon-ebs.kata_baremetal"]

  provisioner "shell" {
    environment_vars = [
      "KATA_VERSION=${var.kata_version}"
    ]
    script = "install-kata.sh"
  }
}
