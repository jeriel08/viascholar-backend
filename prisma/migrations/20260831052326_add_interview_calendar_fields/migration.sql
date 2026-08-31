-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "interview_calendar_event_id" VARCHAR(255),
ADD COLUMN     "interview_meeting_link" VARCHAR(255),
ADD COLUMN     "reschedule_reason" TEXT;

-- AlterTable
ALTER TABLE "grade_reports" ALTER COLUMN "gpa" SET DATA TYPE DECIMAL(5,2);
