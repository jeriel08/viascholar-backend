/*
  Warnings:

  - The values [VERIFIED] on the enum `GradeReportStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `document_url` on the `grade_reports` table. All the data in the column will be lost.
  - You are about to drop the column `file_name` on the `grade_reports` table. All the data in the column will be lost.
  - You are about to drop the column `file_size` on the `grade_reports` table. All the data in the column will be lost.
  - Added the required column `file_type` to the `scholar_documents` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentStatus" ADD VALUE 'PASSED_PRECHECK';
ALTER TYPE "DocumentStatus" ADD VALUE 'NEEDS_REUPLOAD';

-- AlterEnum
BEGIN;
CREATE TYPE "GradeReportStatus_new" AS ENUM ('PENDING', 'APPROVED', 'FLAGGED', 'REJECTED');
ALTER TABLE "public"."grade_reports" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "grade_reports" ALTER COLUMN "status" TYPE "GradeReportStatus_new" USING ("status"::text::"GradeReportStatus_new");
ALTER TYPE "GradeReportStatus" RENAME TO "GradeReportStatus_old";
ALTER TYPE "GradeReportStatus_new" RENAME TO "GradeReportStatus";
DROP TYPE "public"."GradeReportStatus_old";
ALTER TABLE "grade_reports" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "grade_reports" DROP COLUMN "document_url",
DROP COLUMN "file_name",
DROP COLUMN "file_size",
ADD COLUMN     "document_id" INTEGER,
ADD COLUMN     "evaluation_flag" VARCHAR(50),
ADD COLUMN     "is_eligible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "scholar_documents" ADD COLUMN     "extracted_data" JSONB,
ADD COLUMN     "file_type" VARCHAR(20) NOT NULL,
ADD COLUMN     "parseur_doc_id" VARCHAR(100),
ADD COLUMN     "rejection_reason" TEXT;

-- CreateTable
CREATE TABLE "grade_items" (
    "item_id" SERIAL NOT NULL,
    "report_id" INTEGER NOT NULL,
    "subject_code" VARCHAR(50) NOT NULL,
    "subject_name" VARCHAR(150),
    "units" DECIMAL(3,1) NOT NULL,
    "grade" DECIMAL(5,2) NOT NULL,
    "raw_status" VARCHAR(50),

    CONSTRAINT "grade_items_pkey" PRIMARY KEY ("item_id")
);

-- AddForeignKey
ALTER TABLE "grade_reports" ADD CONSTRAINT "grade_reports_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "grade_reports"("report_id") ON DELETE CASCADE ON UPDATE CASCADE;
