CREATE TABLE "security_rate_limits" (
  "scope" text NOT NULL,
  "key_hash" text NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "window_expires_at" timestamp with time zone NOT NULL,
  "blocked_until" timestamp with time zone,
  "retire_at" timestamp with time zone NOT NULL,
  CONSTRAINT "security_rate_limits_scope_key_hash_pk" PRIMARY KEY("scope","key_hash"),
  CONSTRAINT "security_rate_limits_key_hash_check" CHECK ("security_rate_limits"."key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "security_rate_limits_count_check" CHECK ("security_rate_limits"."count" >= 0),
  CONSTRAINT "security_rate_limits_retire_check" CHECK ("security_rate_limits"."retire_at" >= "security_rate_limits"."window_expires_at" AND ("security_rate_limits"."blocked_until" IS NULL OR "security_rate_limits"."retire_at" >= "security_rate_limits"."blocked_until"))
);
--> statement-breakpoint
CREATE INDEX "security_rate_limits_retire_at_index" ON "security_rate_limits" USING btree ("retire_at");