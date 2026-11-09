-- AlterTable
ALTER TABLE "academic_programs" ADD COLUMN     "archive_notes" TEXT,
ADD COLUMN     "archive_reason" VARCHAR(100),
ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by_user_id" INTEGER;

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "scholar_profiles" ADD COLUMN     "archive_notes" TEXT,
ADD COLUMN     "archive_reason" VARCHAR(100),
ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by_user_id" INTEGER;

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "archive_notes" TEXT,
ADD COLUMN     "archive_reason" VARCHAR(100),
ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by_user_id" INTEGER;

-- CreateIndex
CREATE INDEX "academic_programs_archived_at_idx" ON "academic_programs"("archived_at");

-- CreateIndex
CREATE INDEX "applications_archived_at_idx" ON "applications"("archived_at");

-- CreateIndex
CREATE INDEX "scholar_profiles_archived_at_idx" ON "scholar_profiles"("archived_at");

-- CreateIndex
CREATE INDEX "schools_archived_at_idx" ON "schools"("archived_at");

-- AddForeignKey
ALTER TABLE "scholar_profiles" ADD CONSTRAINT "scholar_profiles_archived_by_user_id_fkey" FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schools" ADD CONSTRAINT "schools_archived_by_user_id_fkey" FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_programs" ADD CONSTRAINT "academic_programs_archived_by_user_id_fkey" FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
