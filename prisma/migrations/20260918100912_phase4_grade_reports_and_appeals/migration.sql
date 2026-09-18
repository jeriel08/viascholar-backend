-- AlterTable
ALTER TABLE "grade_reports" ADD COLUMN     "appeal_decision_notes" TEXT,
ADD COLUMN     "appeal_document_id" INTEGER,
ADD COLUMN     "appeal_notes" TEXT,
ADD COLUMN     "appeal_reviewed_at" TIMESTAMP(3),
ADD COLUMN     "appeal_reviewed_by_employee_id" INTEGER,
ADD COLUMN     "appeal_status" VARCHAR(50) NOT NULL DEFAULT 'NONE',
ADD COLUMN     "appeal_submitted_at" TIMESTAMP(3),
ADD COLUMN     "term_enrollment_id" INTEGER;

-- AddForeignKey
ALTER TABLE "grade_reports" ADD CONSTRAINT "grade_reports_appeal_document_id_fkey" FOREIGN KEY ("appeal_document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_reports" ADD CONSTRAINT "grade_reports_appeal_reviewed_by_employee_id_fkey" FOREIGN KEY ("appeal_reviewed_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_reports" ADD CONSTRAINT "grade_reports_term_enrollment_id_fkey" FOREIGN KEY ("term_enrollment_id") REFERENCES "term_enrollments"("enrollment_id") ON DELETE SET NULL ON UPDATE CASCADE;
