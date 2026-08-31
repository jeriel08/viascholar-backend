/*
  Warnings:

  - You are about to drop the column `sponsor_employee_id` on the `scholar_profiles` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "scholar_profiles" DROP CONSTRAINT "scholar_profiles_sponsor_employee_id_fkey";

-- AlterTable
ALTER TABLE "scholar_profiles" DROP COLUMN "sponsor_employee_id",
ADD COLUMN     "relative_employee" VARCHAR(150);
