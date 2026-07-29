variable "cell" {
  description = "Regional cell identifier. No guest data crosses a cell boundary (§58)."
  type        = string
  validation {
    condition     = contains(["in", "eu", "me", "us", "apac"], var.cell)
    error_message = "cell must be one of: in, eu, me, us, apac."
  }
}

variable "region" {
  description = "AWS region for this cell."
  type        = string
}

variable "azs" {
  description = "Availability zones. Two minimum — multi-AZ is a precondition of the 99.5% SLO (§67)."
  type        = list(string)
  validation {
    condition     = length(var.azs) >= 2
    error_message = "at least two availability zones are required."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "organization" {
  description = "Subject organisation on the device CA."
  type        = string
  default     = "Smart Beings"
}

variable "postgres_version" {
  type    = string
  default = "16.4"
}

variable "db_min_acu" {
  description = "Aurora Serverless v2 floor. Voice traffic is bursty and diurnal (§64)."
  type        = number
  default     = 0.5
}

variable "db_max_acu" {
  type    = number
  default = 8
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.medium"
}

variable "audit_retention_days" {
  description = "13 months. Tool calls and policy verdicts outlive transcripts because they resolve disputes and contain far less personal data (§57)."
  type        = number
  default     = 400
}

variable "transcript_retention_days" {
  description = "Ceiling on transcript retention; per-property config may be shorter, never longer (§57)."
  type        = number
  default     = 30
}
