-- CreateTable
CREATE TABLE "schools" (
    "school_id" SERIAL NOT NULL,
    "school_name" VARCHAR(150) NOT NULL,
    "school_code" VARCHAR(50),
    "address" TEXT,
    "contact_email" VARCHAR(100),
    "contact_number" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "grading_system_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("school_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schools_school_name_key" ON "schools"("school_name");

-- CreateIndex
CREATE UNIQUE INDEX "schools_school_code_key" ON "schools"("school_code");

-- RenameForeignKey
ALTER TABLE "scholar_profiles" RENAME CONSTRAINT "scholar_profiles_school_id_fkey" TO "scholar_profiles_school_grading_fkey";

-- AddForeignKey
ALTER TABLE "scholar_profiles" ADD CONSTRAINT "scholar_profiles_school_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("school_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schools" ADD CONSTRAINT "schools_grading_system_id_fkey" FOREIGN KEY ("grading_system_id") REFERENCES "school_grading_systems"("school_id") ON DELETE SET NULL ON UPDATE CASCADE;
