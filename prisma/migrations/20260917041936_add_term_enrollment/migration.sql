-- CreateTable
CREATE TABLE "term_enrollments" (
    "enrollment_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(15) NOT NULL,
    "semester" VARCHAR(20) NOT NULL,
    "year_level" SMALLINT NOT NULL,
    "is_consolidated" BOOLEAN NOT NULL DEFAULT false,
    "cor_document_id" INTEGER,
    "soa_document_id" INTEGER,
    "total_units" DECIMAL(4,1) NOT NULL,
    "total_assessment" DECIMAL(10,2) NOT NULL,
    "assessment_date" DATE,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING_REVIEW',
    "audit_flags" JSONB,
    "enrolled_subjects" JSONB,
    "billing_breakdown" JSONB,
    "cross_doc_reconciliation" JSONB,
    "reviewed_by_employee_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "coordinator_notes" TEXT,
    "disbursement_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "term_enrollments_pkey" PRIMARY KEY ("enrollment_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "term_enrollments_disbursement_id_key" ON "term_enrollments"("disbursement_id");

-- CreateIndex
CREATE INDEX "term_enrollments_scholar_profile_id_idx" ON "term_enrollments"("scholar_profile_id");

-- CreateIndex
CREATE INDEX "term_enrollments_status_idx" ON "term_enrollments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "term_enrollments_scholar_profile_id_academic_year_semester_key" ON "term_enrollments"("scholar_profile_id", "academic_year", "semester");

-- AddForeignKey
ALTER TABLE "term_enrollments" ADD CONSTRAINT "term_enrollments_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_enrollments" ADD CONSTRAINT "term_enrollments_cor_document_id_fkey" FOREIGN KEY ("cor_document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_enrollments" ADD CONSTRAINT "term_enrollments_soa_document_id_fkey" FOREIGN KEY ("soa_document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_enrollments" ADD CONSTRAINT "term_enrollments_reviewed_by_employee_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_enrollments" ADD CONSTRAINT "term_enrollments_disbursement_id_fkey" FOREIGN KEY ("disbursement_id") REFERENCES "disbursements"("disbursement_id") ON DELETE SET NULL ON UPDATE CASCADE;
