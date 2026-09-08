-- Revive the meetings table as the staff-facing interview schedule store.
-- Adds the link back to applications plus the real scheduling fields, then
-- backfills rows for interviews that were already scheduled on applications.

ALTER TABLE "meetings" ADD COLUMN "application_id" INTEGER,
ADD COLUMN "scheduled_at" TIMESTAMP(3),
ADD COLUMN "duration_minutes" INTEGER DEFAULT 45,
ADD COLUMN "meeting_link" VARCHAR(255),
ADD COLUMN "calendar_event_id" VARCHAR(255),
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "meetings_application_id_key" ON "meetings"("application_id");

CREATE INDEX "meetings_scheduled_at_idx" ON "meetings"("scheduled_at");

CREATE INDEX "meetings_status_idx" ON "meetings"("status");

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("application_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one SCHEDULED row per application that already has an interview.
INSERT INTO "meetings" ("scholar_profile_id", "employee_id", "application_id", "title", "meeting_date", "meeting_time", "scheduled_at", "duration_minutes", "meeting_link", "calendar_event_id", "status", "notes")
SELECT
  a."scholar_profile_id",
  a."reviewed_by_employee_id",
  a."application_id",
  'ViaScholar Scholarship Interview',
  (a."interview_at" AT TIME ZONE 'UTC')::date,
  to_char(a."interview_at" AT TIME ZONE 'UTC', 'HH24:MI'),
  a."interview_at",
  45,
  a."interview_meeting_link",
  a."interview_calendar_event_id",
  'SCHEDULED',
  a."provider_notes"
FROM "applications" a
WHERE a."interview_at" IS NOT NULL
ON CONFLICT ("application_id") DO NOTHING;
