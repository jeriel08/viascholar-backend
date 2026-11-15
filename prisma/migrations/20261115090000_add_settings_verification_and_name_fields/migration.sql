-- Add contact verification, 2FA, notification, public profile, and password metadata fields to users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "two_factor_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "two_factor_method" VARCHAR(30) DEFAULT 'EMAIL_OTP',
  ADD COLUMN IF NOT EXISTS "two_factor_secret" TEXT,
  ADD COLUMN IF NOT EXISTS "email_notifs" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "sms_notifs" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "forum_digest" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "public_profile" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);

-- Add middle_name, suffix, and sex to employees
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "middle_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "suffix" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "sex" VARCHAR(30);

-- Add middle_name, suffix, sex, and phone verification fields to scholar_profiles
ALTER TABLE "scholar_profiles"
  ADD COLUMN IF NOT EXISTS "middle_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "suffix" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "sex" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "is_phone_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "phone_verified_at" TIMESTAMP(3);

-- Backfill users settings and verification state from latest USER_SETTINGS_PREFERENCES audit logs
WITH latest_settings AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    created_at,
    details::jsonb AS data
  FROM "audit_logs"
  WHERE user_id IS NOT NULL
    AND action = 'USER_SETTINGS_PREFERENCES'
    AND details IS NOT NULL
    AND details ~ '^\s*\{'
  ORDER BY user_id, created_at DESC, log_id DESC
),
latest_email_verified AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    created_at
  FROM "audit_logs"
  WHERE user_id IS NOT NULL
    AND action = 'EMAIL_VERIFIED'
  ORDER BY user_id, created_at DESC, log_id DESC
)
UPDATE "users" u
SET
  "email_notifs" = COALESCE((ls.data->>'emailNotifs')::boolean, u."email_notifs"),
  "sms_notifs" = COALESCE((ls.data->>'smsNotifs')::boolean, u."sms_notifs"),
  "forum_digest" = COALESCE((ls.data->>'forumDigest')::boolean, u."forum_digest"),
  "two_factor_enabled" = COALESCE((ls.data->>'twoFactor')::boolean, u."two_factor_enabled"),
  "two_factor_method" = CASE
    WHEN COALESCE((ls.data->>'twoFactor')::boolean, true) = false THEN NULL
    WHEN ls.data->>'twoFactorMethod' IN ('EMAIL_OTP', 'SMS_OTP', 'AUTHENTICATOR_APP') THEN ls.data->>'twoFactorMethod'
    ELSE u."two_factor_method"
  END,
  "two_factor_secret" = NULLIF(ls.data->>'twoFactorSecret', ''),
  "is_email_verified" = COALESCE((ls.data->>'emailVerified')::boolean, u."is_email_verified"),
  "email_verified_at" = CASE
    WHEN COALESCE((ls.data->>'emailVerified')::boolean, false) = true
      THEN COALESCE(lev.created_at, ls.created_at)
    ELSE u."email_verified_at"
  END,
  "public_profile" = COALESCE((ls.data->>'publicProfile')::boolean, u."public_profile"),
  "password_changed_at" = CASE
    WHEN NULLIF(ls.data->>'passwordChangedAt', '') IS NOT NULL
      THEN ((ls.data->>'passwordChangedAt')::timestamptz AT TIME ZONE 'UTC')
    ELSE u."password_changed_at"
  END
FROM latest_settings ls
LEFT JOIN latest_email_verified lev ON lev.user_id = ls.user_id
WHERE u."user_id" = ls.user_id;

-- Backfill scholar_profiles phone verification state from latest USER_SETTINGS_PREFERENCES audit logs
WITH latest_settings AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    created_at,
    details::jsonb AS data
  FROM "audit_logs"
  WHERE user_id IS NOT NULL
    AND action = 'USER_SETTINGS_PREFERENCES'
    AND details IS NOT NULL
    AND details ~ '^\s*\{'
  ORDER BY user_id, created_at DESC, log_id DESC
),
latest_phone_verified AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    created_at
  FROM "audit_logs"
  WHERE user_id IS NOT NULL
    AND action = 'PHONE_VERIFIED'
  ORDER BY user_id, created_at DESC, log_id DESC
)
UPDATE "scholar_profiles" sp
SET
  "is_phone_verified" = COALESCE((ls.data->>'phoneVerified')::boolean, sp."is_phone_verified"),
  "phone_verified_at" = CASE
    WHEN COALESCE((ls.data->>'phoneVerified')::boolean, false) = true
      THEN COALESCE(lpv.created_at, ls.created_at)
    ELSE sp."phone_verified_at"
  END
FROM latest_settings ls
LEFT JOIN latest_phone_verified lpv ON lpv.user_id = ls.user_id
WHERE sp."user_id" = ls.user_id;
