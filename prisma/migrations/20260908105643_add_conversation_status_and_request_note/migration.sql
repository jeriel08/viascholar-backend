-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "request_note" TEXT,
ADD COLUMN     "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE';
