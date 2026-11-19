-- CreateTable
CREATE TABLE "submission_deadlines" (
    "deadline_id" SERIAL NOT NULL,
    "requirement_type" VARCHAR(40) NOT NULL,
    "academic_year" VARCHAR(15) NOT NULL,
    "semester" VARCHAR(30) NOT NULL,
    "school_id" INTEGER,
    "due_date" TIMESTAMP(3) NOT NULL,
    "grace_period_days" INTEGER NOT NULL DEFAULT 0,
    "is_optional_term" BOOLEAN NOT NULL DEFAULT false,
    "title" VARCHAR(150),
    "instructions" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submission_deadlines_pkey" PRIMARY KEY ("deadline_id")
);

-- CreateTable
CREATE TABLE "deadline_follow_ups" (
    "follow_up_id" SERIAL NOT NULL,
    "deadline_id" INTEGER NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "sent_by_user_id" INTEGER,
    "channels" JSONB NOT NULL,
    "conversation_id" INTEGER,
    "message_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deadline_follow_ups_pkey" PRIMARY KEY ("follow_up_id")
);

-- CreateTable
CREATE TABLE "deadline_exemptions" (
    "exemption_id" SERIAL NOT NULL,
    "deadline_id" INTEGER NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "reason" TEXT,
    "exempted_by_user_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deadline_exemptions_pkey" PRIMARY KEY ("exemption_id")
);

-- CreateIndex
CREATE INDEX "submission_deadlines_academic_year_semester_requirement_typ_idx" ON "submission_deadlines"("academic_year", "semester", "requirement_type", "is_active");

-- CreateIndex
CREATE INDEX "submission_deadlines_school_id_idx" ON "submission_deadlines"("school_id");

-- CreateIndex
CREATE INDEX "deadline_follow_ups_deadline_id_scholar_profile_id_idx" ON "deadline_follow_ups"("deadline_id", "scholar_profile_id");

-- CreateIndex
CREATE INDEX "deadline_follow_ups_scholar_profile_id_created_at_idx" ON "deadline_follow_ups"("scholar_profile_id", "created_at");

-- CreateIndex
CREATE INDEX "deadline_exemptions_scholar_profile_id_idx" ON "deadline_exemptions"("scholar_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "deadline_exemptions_deadline_id_scholar_profile_id_key" ON "deadline_exemptions"("deadline_id", "scholar_profile_id");

-- AddForeignKey
ALTER TABLE "submission_deadlines" ADD CONSTRAINT "submission_deadlines_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("school_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_deadlines" ADD CONSTRAINT "submission_deadlines_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_follow_ups" ADD CONSTRAINT "deadline_follow_ups_deadline_id_fkey" FOREIGN KEY ("deadline_id") REFERENCES "submission_deadlines"("deadline_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_follow_ups" ADD CONSTRAINT "deadline_follow_ups_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_follow_ups" ADD CONSTRAINT "deadline_follow_ups_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_follow_ups" ADD CONSTRAINT "deadline_follow_ups_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("conversation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_exemptions" ADD CONSTRAINT "deadline_exemptions_deadline_id_fkey" FOREIGN KEY ("deadline_id") REFERENCES "submission_deadlines"("deadline_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_exemptions" ADD CONSTRAINT "deadline_exemptions_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_exemptions" ADD CONSTRAINT "deadline_exemptions_exempted_by_user_id_fkey" FOREIGN KEY ("exempted_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
