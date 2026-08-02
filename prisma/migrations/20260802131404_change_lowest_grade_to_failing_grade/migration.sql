/*
  Warnings:

  - You are about to drop the column `lowest_grade` on the `school_grading_systems` table. All the data in the column will be lost.
  - Added the required column `failing_grade` to the `school_grading_systems` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "school_grading_systems" DROP COLUMN "lowest_grade",
ADD COLUMN     "failing_grade" DECIMAL(5,2) NOT NULL;
