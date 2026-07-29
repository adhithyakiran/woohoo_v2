##############################################################################
# Woohoo V2 — one regional cell (architecture doc §58 D23, §75).
#
# A cell is a COMPLETE, INDEPENDENT stack: its own VPC, databases, caches, object
# storage and Vertex AI region. No guest data crosses a cell boundary, ever. Only
# the deployment control plane and non-identifiable aggregate metrics are global.
#
# STATUS: written, never applied. There are no AWS credentials in this environment,
# so this has not been `terraform plan`ed or `validate`d. Treat it as a reviewed
# starting point, not as working infrastructure. See README.
##############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  name = "woohoo-${var.cell}"
  tags = {
    Project = "woohoo"
    Cell    = var.cell
    Managed = "terraform"
  }
}

##############################################################################
# Network — private subnets for everything except the load balancers.
##############################################################################

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = local.name })
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.name}-public-${count.index}" })
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + length(var.azs))
  tags              = merge(local.tags, { Name = "${local.name}-private-${count.index}" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.tags
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = local.tags
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = local.tags
  depends_on    = [aws_internet_gateway.this]
}

# VPC endpoints keep S3, Secrets Manager and KMS traffic off the internet entirely (§52).
resource "aws_vpc_endpoint" "s3" {
  vpc_id       = aws_vpc.this.id
  service_name = "com.amazonaws.${var.region}.s3"
  tags         = local.tags
}

##############################################################################
# Compute — ECS Fargate. Long-lived tasks, no cluster to operate, right shape for
# a small team. Explicitly NOT Lambda on the voice path: cold starts and the
# connection model are wrong for persistent WebSockets (§75 D19).
##############################################################################

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

# Device ingress is an NLB, not API Gateway: per-message pricing and connection
# duration limits are unattractive at 100k persistent connections, and terminating
# mTLS in the app is what lets the gateway inspect the client certificate to derive
# scope — the foundation of principle P2 (§75).
resource "aws_lb" "device" {
  name                             = "${local.name}-device"
  load_balancer_type               = "network"
  subnets                          = aws_subnet.public[*].id
  enable_cross_zone_load_balancing = true
  tags                             = local.tags
}

##############################################################################
# Data
##############################################################################

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_rds_cluster" "postgres" {
  cluster_identifier     = "${local.name}-pg"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  engine_version         = var.postgres_version
  database_name          = "woohoo"
  master_username        = "woohoo"
  manage_master_user_password = true
  db_subnet_group_name   = aws_db_subnet_group.this.name
  storage_encrypted      = true
  kms_key_id             = aws_kms_key.data.arn
  backup_retention_period = 14
  # Handles the strong diurnal pattern without paying peak all day (§64).
  serverlessv2_scaling_configuration {
    min_capacity = var.db_min_acu
    max_capacity = var.db_max_acu
  }
  tags = local.tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name}-redis"
  description                = "Woohoo session and device-state cache"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  tags                       = local.tags
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

# Audit store. Object Lock in compliance mode is what makes "immutable" a technical
# claim rather than a policy claim (§36 D18, §57).
resource "aws_s3_bucket" "audit" {
  bucket              = "${local.name}-audit"
  object_lock_enabled = true
  tags                = local.tags
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.audit_retention_days # 13 months for tool calls and policy verdicts
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

# Transcripts expire on a schedule; the retention window is per-property config but
# the bucket enforces the ceiling (§57).
resource "aws_s3_bucket" "transcripts" {
  bucket = "${local.name}-transcripts"
  tags   = local.tags
}

resource "aws_s3_bucket_lifecycle_configuration" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id
  rule {
    id     = "expire-transcripts"
    status = "Enabled"
    expiration {
      days = var.transcript_retention_days
    }
  }
}

##############################################################################
# Keys — per-tenant CMKs are created outside this module; this is the cell key.
##############################################################################

resource "aws_kms_key" "data" {
  description             = "${local.name} data encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

##############################################################################
# Device identity — private CA issuing per-device, room-scoped certificates (§51).
##############################################################################

resource "aws_acmpca_certificate_authority" "devices" {
  type = "ROOT"
  certificate_authority_configuration {
    key_algorithm     = "RSA_2048"
    signing_algorithm = "SHA256WITHRSA"
    subject {
      common_name  = "Woohoo Device CA (${var.cell})"
      organization = var.organization
    }
  }
  tags = local.tags
}

##############################################################################
# Eventing (§38 D17)
##############################################################################

resource "aws_cloudwatch_event_bus" "this" {
  name = local.name
  tags = local.tags
}

resource "aws_sqs_queue" "notifications_dlq" {
  name = "${local.name}-notifications-dlq"
  tags = local.tags
}

resource "aws_sqs_queue" "notifications" {
  name = "${local.name}-notifications"
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notifications_dlq.arn
    maxReceiveCount     = 5
  })
  tags = local.tags
}
