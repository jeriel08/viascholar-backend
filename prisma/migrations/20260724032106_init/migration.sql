-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'EMPLOYEE', 'SCHOLAR');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GradeReportStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING', 'SIGNED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('PENDING', 'RELEASED', 'CLAIMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "user_id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'SCHOLAR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "employees" (
    "employee_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "title" VARCHAR(150),
    "department" VARCHAR(150),
    "bio" TEXT,
    "avatar_url" VARCHAR(255),
    "banner_url" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "scholar_profiles" (
    "profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "sponsor_employee_id" INTEGER,
    "scholarship_track" VARCHAR(100),
    "course_of_study" VARCHAR(150),
    "school_name" VARCHAR(150),
    "current_year_level" SMALLINT,
    "bio" TEXT,
    "avatar_url" VARCHAR(255),
    "banner_url" VARCHAR(255),
    "student_number" VARCHAR(50),

    CONSTRAINT "scholar_profiles_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "applications" (
    "application_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "reviewed_by_employee_id" INTEGER,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "stage" VARCHAR(100) NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stage_updated_at" TIMESTAMP(3),
    "interview_at" TIMESTAMP(3),
    "decision_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "provider_notes" TEXT,
    "rejection_reason" TEXT,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "applications_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "grade_reports" (
    "report_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(15) NOT NULL,
    "semester" VARCHAR(15) NOT NULL,
    "term" VARCHAR(15),
    "gpa" DECIMAL(3,2) NOT NULL,
    "document_url" VARCHAR(255),
    "file_name" VARCHAR(100),
    "file_size" VARCHAR(50),
    "status" "GradeReportStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_employee_id" INTEGER,
    "remarks" TEXT,

    CONSTRAINT "grade_reports_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "contract_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "signed_by_user_id" INTEGER,
    "contract_number" VARCHAR(100) NOT NULL,
    "document_url" VARCHAR(255),
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING',
    "effective_date" DATE,
    "expiry_date" DATE,
    "signed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("contract_id")
);

-- CreateTable
CREATE TABLE "disbursements" (
    "disbursement_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(15) NOT NULL,
    "semester" VARCHAR(15) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "check_payee" VARCHAR(100),
    "check_number" VARCHAR(100),
    "payment_method" VARCHAR(100),
    "status" "DisbursementStatus" NOT NULL DEFAULT 'PENDING',
    "date_issued" DATE,
    "date_claimed" DATE,
    "approved_by_employee_id" INTEGER,
    "remarks" TEXT,

    CONSTRAINT "disbursements_pkey" PRIMARY KEY ("disbursement_id")
);

-- CreateTable
CREATE TABLE "scholar_documents" (
    "document_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER NOT NULL,
    "document_type" VARCHAR(100) NOT NULL,
    "label" VARCHAR(100),
    "file_name" VARCHAR(100),
    "file_url" VARCHAR(255) NOT NULL,
    "file_size" VARCHAR(100),
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),
    "reviewed_by_employee_id" INTEGER,

    CONSTRAINT "scholar_documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "conversation_id" SERIAL NOT NULL,
    "subject" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("conversation_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "message_id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "sender_user_id" INTEGER NOT NULL,
    "message_text" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "meeting_id" SERIAL NOT NULL,
    "scholar_profile_id" INTEGER,
    "employee_id" INTEGER,
    "title" VARCHAR(150) NOT NULL,
    "meeting_date" DATE NOT NULL,
    "meeting_time" VARCHAR(50),
    "invitee_role" VARCHAR(100),
    "status" VARCHAR(100),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("meeting_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scholar_profiles_user_id_key" ON "scholar_profiles"("user_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_profiles" ADD CONSTRAINT "scholar_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_profiles" ADD CONSTRAINT "scholar_profiles_sponsor_employee_id_fkey" FOREIGN KEY ("sponsor_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_reviewed_by_employee_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_reports" ADD CONSTRAINT "grade_reports_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_reports" ADD CONSTRAINT "grade_reports_reviewed_by_employee_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_signed_by_user_id_fkey" FOREIGN KEY ("signed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_approved_by_employee_id_fkey" FOREIGN KEY ("approved_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_documents" ADD CONSTRAINT "scholar_documents_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholar_documents" ADD CONSTRAINT "scholar_documents_reviewed_by_employee_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_scholar_profile_id_fkey" FOREIGN KEY ("scholar_profile_id") REFERENCES "scholar_profiles"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;
