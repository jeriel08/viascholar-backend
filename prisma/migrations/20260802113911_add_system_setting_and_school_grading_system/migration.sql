-- CreateTable
CREATE TABLE "system_settings" (
    "setting_id" SERIAL NOT NULL,
    "grade_threshold" DECIMAL(5,2) NOT NULL DEFAULT 90.00,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" INTEGER,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("setting_id")
);

-- CreateTable
CREATE TABLE "school_grading_systems" (
    "school_id" SERIAL NOT NULL,
    "school_name" VARCHAR(150) NOT NULL,
    "grading_scale" VARCHAR(50) NOT NULL,
    "passing_grade" DECIMAL(5,2) NOT NULL,
    "highest_grade" DECIMAL(5,2) NOT NULL,
    "lowest_grade" DECIMAL(5,2) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_grading_systems_pkey" PRIMARY KEY ("school_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_grading_systems_school_name_key" ON "school_grading_systems"("school_name");

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
