##############################################################################
# Cell: in (India) — ap-south-1.
#
# One module instantiation per cell. Build the SECOND cell early, before you need
# it: the first cell is architecture, the second is what proves the architecture.
# Discovering region-coupling assumptions during a contractual residency deadline
# is a bad way to find them (§58).
##############################################################################

terraform {
  required_version = ">= 1.6"
  backend "s3" {
    # bucket / key / region supplied via -backend-config per environment.
    encrypt = true
  }
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = {
      Project = "woohoo"
      Cell    = "in"
    }
  }
}

module "cell" {
  source = "../../modules/cell"

  cell   = "in"
  region = "ap-south-1"
  azs    = ["ap-south-1a", "ap-south-1b"]

  vpc_cidr = "10.40.0.0/16"

  # India is the first production market; sized for the 10k-device scale point (§64).
  db_min_acu      = 0.5
  db_max_acu      = 8
  redis_node_type = "cache.t4g.medium"

  # DPDP Act 2023 — confirm the current rules before launch (§59).
  transcript_retention_days = 30
  audit_retention_days      = 400
}

output "device_endpoint" {
  value       = module.cell.device_nlb_dns
  description = "Device WebSocket ingress for this cell."
}
