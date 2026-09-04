/*
  Warnings:

  - A unique constraint covering the columns `[certificate_id]` on the table `contracts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phone_number]` on the table `scholar_profiles` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[student_number]` on the table `scholar_profiles` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `phone_number` to the `scholar_profiles` table without a default value. This is not possible if the table is not empty.
  - Added the required column `school_address` to the `scholar_profiles` table without a default value. This is not possible if the table is not empty.
  - Added the required column `student_address` to the `scholar_profiles` table without a default value. This is not possible if the table is not empty.
  - Made the column `scholarship_track` on table `scholar_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `course_of_study` on table `scholar_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `school_name` on table `scholar_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `student_number` on table `scholar_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `relative_employee` on table `scholar_profiles` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "certificate_id" VARCHAR(100),
ADD COLUMN     "document_hash" VARCHAR(128),
ADD COLUMN     "signature_url" VARCHAR(255),
ADD COLUMN     "signed_document_url" VARCHAR(255),
ADD COLUMN     "signer_ip" VARCHAR(100),
ADD COLUMN     "signer_user_agent" TEXT;

-- AlterTable
ALTER TABLE "scholar_profiles" ADD COLUMN     "phone_number" VARCHAR(30) NOT NULL,
ADD COLUMN     "school_address" TEXT NOT NULL,
ADD COLUMN     "student_address" TEXT NOT NULL,
ALTER COLUMN "scholarship_track" SET NOT NULL,
ALTER COLUMN "course_of_study" SET NOT NULL,
ALTER COLUMN "school_name" SET NOT NULL,
ALTER COLUMN "student_number" SET NOT NULL,
ALTER COLUMN "relative_employee" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "contracts_certificate_id_key" ON "contracts"("certificate_id");

-- CreateIndex
CREATE UNIQUE INDEX "scholar_profiles_phone_number_key" ON "scholar_profiles"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "scholar_profiles_student_number_key" ON "scholar_profiles"("student_number");
