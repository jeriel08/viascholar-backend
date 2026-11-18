-- CreateTable
CREATE TABLE "scholar_prospectus_history" (
    "history_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "academic_change_request_id" INTEGER,
    "document_id" INTEGER,
    "curriculum_year" VARCHAR(50) NOT NULL,
    "course_code" VARCHAR(50),
    "course_name" VARCHAR(150) NOT NULL,
    "school_name" VARCHAR(150),
    "total_units" DECIMAL(5,1),
    "credited_units" DECIMAL(5,1),
    "status" VARCHAR(50) NOT NULL DEFAULT 'ARCHIVED',
    "archive_reason" VARCHAR(50) NOT NULL DEFAULT 'PROGRAM_SHIFT',
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "frozen_at" TIMESTAMP(3),
    "subjects_snapshot" JSONB NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scholar_prospectus_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateIndex
CREATE INDEX "scholar_prospectus_history_scholar_profile_id_archived_at_idx" ON "scholar_prospectus_history"("scholar_profile_id", "archived_at");

-- AddForeignKey
ALTER TABLE "scholar_prospectus_history" ADD CONSTRAINT "scholar_prospectus_history_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_prospectus_history" ADD CONSTRAINT "scholar_prospectus_history_academic_change_request_id_fkey" FOREIGN KEY ("academic_change_request_id") REFERENCES "academic_change_requests"("request_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_prospectus_history" ADD CONSTRAINT "scholar_prospectus_history_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;
