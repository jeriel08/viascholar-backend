-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "message_type" VARCHAR(50) NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "metadata" JSONB;
