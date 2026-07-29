output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "device_nlb_dns" {
  description = "Device WebSocket ingress. mTLS is terminated in the application, not here, so the gateway can inspect the client certificate to derive scope (P2)."
  value       = aws_lb.device.dns_name
}

output "postgres_endpoint" {
  value = aws_rds_cluster.postgres.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "audit_bucket" {
  description = "WORM audit store. Object Lock is in COMPLIANCE mode — it cannot be shortened, including by the account root."
  value       = aws_s3_bucket.audit.bucket
}

output "device_ca_arn" {
  value = aws_acmpca_certificate_authority.devices.arn
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.this.name
}
