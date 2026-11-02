-- CreateTable
CREATE TABLE "academic_programs" (
    "program_id" SERIAL NOT NULL,
    "program_code" VARCHAR(50) NOT NULL,
    "program_name" VARCHAR(150) NOT NULL,
    "category" VARCHAR(50) DEFAULT 'College',
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_programs_pkey" PRIMARY KEY ("program_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academic_programs_program_code_key" ON "academic_programs"("program_code");

-- CreateIndex
CREATE UNIQUE INDEX "academic_programs_program_name_key" ON "academic_programs"("program_name");
