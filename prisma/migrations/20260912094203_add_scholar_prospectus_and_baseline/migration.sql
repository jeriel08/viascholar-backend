-- AlterTable
ALTER TABLE "scholar_profiles" ADD COLUMN     "academic_baseline_status" VARCHAR(50) NOT NULL DEFAULT 'PENDING_SCHOOL_SELECTION',
ADD COLUMN     "school_id" INTEGER;

-- AlterTable
ALTER TABLE "school_grading_systems" ADD COLUMN     "is_verified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "max_grade" DECIMAL(5,2),
ADD COLUMN     "min_grade" DECIMAL(5,2),
ADD COLUMN     "submitted_by_user_id" INTEGER,
ADD COLUMN     "verified_by_employee_id" INTEGER;

-- CreateTable
CREATE TABLE "scholar_prospectus" (
    "prospectus_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "document_id" INTEGER,
    "curriculum_year" VARCHAR(50) NOT NULL,
    "course_code" VARCHAR(50),
    "course_name" VARCHAR(150) NOT NULL,
    "total_units" DECIMAL(5,1),
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "frozen_at" TIMESTAMP(3),
    "frozen_by_employee_id" INTEGER,
    "status" VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scholar_prospectus_pkey" PRIMARY KEY ("prospectus_id")
);

-- CreateTable
CREATE TABLE "prospectus_subjects" (
    "subject_id" SERIAL NOT NULL,
    "prospectus_id" INTEGER NOT NULL,
    "subject_code" VARCHAR(50) NOT NULL,
    "descriptive_title" VARCHAR(200) NOT NULL,
    "units" DECIMAL(3,1) NOT NULL,
    "year_level" SMALLINT NOT NULL,
    "semester" VARCHAR(50) NOT NULL,
    "prerequisites" JSONB,
    "status" VARCHAR(50) NOT NULL DEFAULT 'UNTAKEN',
    "grade" DECIMAL(5,2),
    "historical_document_id" INTEGER,
    "credited_term" VARCHAR(50),
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospectus_subjects_pkey" PRIMARY KEY ("subject_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scholar_prospectus_scholar_profile_id_key" ON "scholar_prospectus"("scholar_profile_id");

-- CreateIndex
CREATE INDEX "prospectus_subjects_prospectus_id_idx" ON "prospectus_subjects"("prospectus_id");

-- CreateIndex
CREATE INDEX "prospectus_subjects_subject_code_idx" ON "prospectus_subjects"("subject_code");

-- AddForeignKey
ALTER TABLE "scholar_profiles" ADD CONSTRAINT "scholar_profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school_grading_systems"("school_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_grading_systems" ADD CONSTRAINT "school_grading_systems_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_grading_systems" ADD CONSTRAINT "school_grading_systems_verified_by_employee_id_fkey" FOREIGN KEY ("verified_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_prospectus" ADD CONSTRAINT "scholar_prospectus_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_prospectus" ADD CONSTRAINT "scholar_prospectus_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_prospectus" ADD CONSTRAINT "scholar_prospectus_frozen_by_employee_id_fkey" FOREIGN KEY ("frozen_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospectus_subjects" ADD CONSTRAINT "prospectus_subjects_prospectus_id_fkey" FOREIGN KEY ("prospectus_id") REFERENCES "scholar_prospectus"("prospectus_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospectus_subjects" ADD CONSTRAINT "prospectus_subjects_historical_document_id_fkey" FOREIGN KEY ("historical_document_id") REFERENCES "scholar_documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;
