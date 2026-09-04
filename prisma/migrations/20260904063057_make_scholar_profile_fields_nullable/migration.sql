-- AlterTable
ALTER TABLE "scholar_profiles" ALTER COLUMN "scholarship_track" DROP NOT NULL,
ALTER COLUMN "course_of_study" DROP NOT NULL,
ALTER COLUMN "school_name" DROP NOT NULL,
ALTER COLUMN "student_number" DROP NOT NULL,
ALTER COLUMN "relative_employee" DROP NOT NULL,
ALTER COLUMN "school_address" DROP NOT NULL,
ALTER COLUMN "student_address" DROP NOT NULL;
