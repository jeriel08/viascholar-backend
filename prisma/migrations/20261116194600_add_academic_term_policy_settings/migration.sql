-- Add automatic academic year rollover and strict active-term policy settings to system_settings
ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "ay_rollover_month" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "strict_active_term_policy" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "manual_academic_year" VARCHAR(15),
  ADD COLUMN IF NOT EXISTS "manual_semester" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "manual_override_expires_at" DATE;
