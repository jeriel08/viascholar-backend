-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DisbursementStatus" ADD VALUE 'AUTHORIZED';
ALTER TYPE "DisbursementStatus" ADD VALUE 'CHECK_ISSUED';
ALTER TYPE "DisbursementStatus" ADD VALUE 'OR_SUBMITTED';
ALTER TYPE "DisbursementStatus" ADD VALUE 'SETTLED';

-- AlterTable
ALTER TABLE "disbursements" ADD COLUMN     "bank_name" VARCHAR(100),
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "or_document_id" INTEGER,
ADD COLUMN     "or_number" VARCHAR(100),
ADD COLUMN     "or_payment_date" DATE,
ADD COLUMN     "or_verified_at" TIMESTAMP(3),
ADD COLUMN     "settled_at" TIMESTAMP(3),
ADD COLUMN     "settled_by_employee_id" INTEGER,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "voucher_number" VARCHAR(100),
ALTER COLUMN "check_payee" SET DATA TYPE VARCHAR(150);

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_settled_by_employee_id_fkey" FOREIGN KEY ("settled_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_or_document_id_fkey" FOREIGN KEY ("or_document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;
