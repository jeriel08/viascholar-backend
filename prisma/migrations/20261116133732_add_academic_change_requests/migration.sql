-- CreateTable
CREATE TABLE "academic_change_requests" (
    "request_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "change_type" VARCHAR(30) NOT NULL,
    "current_course_of_study" VARCHAR(150),
    "current_school_id" INTEGER,
    "current_school_name" VARCHAR(150),
    "requested_program_id" INTEGER,
    "requested_course_of_study" VARCHAR(150),
    "requested_school_id" INTEGER,
    "requested_school_name" VARCHAR(150),
    "effective_academic_year" VARCHAR(15),
    "effective_semester" VARCHAR(30),
    "reason" TEXT NOT NULL,
    "supporting_document_id" INTEGER,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_GRANTOR',
    "reviewed_by_user_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "decision_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_change_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE INDEX "academic_change_requests_scholar_profile_id_status_idx" ON "academic_change_requests"("scholar_profile_id", "status");

-- CreateIndex
CREATE INDEX "academic_change_requests_status_created_at_idx" ON "academic_change_requests"("status", "created_at");

-- AddForeignKey
ALTER TABLE "academic_change_requests" ADD CONSTRAINT "academic_change_requests_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_change_requests" ADD CONSTRAINT "academic_change_requests_requested_program_id_fkey" FOREIGN KEY ("requested_program_id") REFERENCES "academic_programs"("program_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_change_requests" ADD CONSTRAINT "academic_change_requests_supporting_document_id_fkey" FOREIGN KEY ("supporting_document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_change_requests" ADD CONSTRAINT "academic_change_requests_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
