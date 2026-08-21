-- AlterEnum
ALTER TYPE "DocumentStatus" ADD VALUE 'STUDENT_CONFIRMED';

-- AlterTable
ALTER TABLE "scholar_documents" ADD COLUMN     "confirmed_data" JSONB;
