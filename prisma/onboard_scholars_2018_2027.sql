-- =============================================================================
-- ViaScholar Legacy Scholar Onboarding Script (SY 2018-2019 through SY 2026-2027)
-- Source: Francisco & Laureanne Lorenzo Scholarship Program (SCHOLARS.xlsx)
-- Scope: 13 College Scholars (105 term enrollments, 105 disbursements, 105 grade reports)
-- Notes:
--   * Preserves all existing staff and test accounts (user_id 1..8) untouched.
--   * Uses anonymized @viascholar.demo emails & dummy phone numbers (privacy-safe).
--   * Idempotent & transaction-wrapped: safe to run once or re-run without duplicates.
--   * Default password for all @viascholar.demo accounts: Scholar123!
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Sync Schools & School Grading Systems (Dual-FK alignment on scholar_profiles)
--    Existing DB has schools(1..7) and school_grading_systems(1..5).
--    We add SPC (6), UIC (7), HCCC (8), HCDC (9), DMSF (10), DMMA (11), MMFC (12)
--    to school_grading_systems and HCCC..MMFC (8..12) to schools so every school_id
--    satisfies both scholar_profiles_school_fkey and scholar_profiles_school_grading_fkey.
-- -----------------------------------------------------------------------------
INSERT INTO public.school_grading_systems (
  school_id, school_name, grading_scale, passing_grade, highest_grade, failing_grade,
  min_grade, max_grade, is_verified, verified_by_employee_id, notes, created_at, updated_at
)
VALUES
  (6,  'San Pedro College',                      'PERCENTAGE_100',  75.00, 100.00, 50.00, 50.00, 100.00, true, 2, 'Percentage grading scale (75% passing, 100% highest) aligned with school_id=6.', NOW(), NOW()),
  (7,  'University of the Immaculate Conception', 'NUMERIC_4_POINT', 2.00,   4.00,  1.00,  1.00,   4.00, true, 2, '4-point grading scale aligned with school_id=7.', NOW(), NOW()),
  (8,  'Holy Cross College of Calinan, Inc.',    'PERCENTAGE_100',  75.00, 100.00, 50.00, 50.00, 100.00, true, 2, 'Percentage grading scale from company scholarship report (SY 2018-2027).', NOW(), NOW()),
  (9,  'Holy Cross of Davao College, Inc.',      'PERCENTAGE_100',  75.00, 100.00, 50.00, 50.00, 100.00, true, 2, 'Percentage grading scale from company scholarship report (SY 2020-2024).', NOW(), NOW()),
  (10, 'Davao Medical School Foundation, Inc.',  'PERCENTAGE_100',  75.00, 100.00, 50.00, 50.00, 100.00, true, 2, 'Percentage grading scale from company scholarship report (SY 2022-2026).', NOW(), NOW()),
  (11, 'DMMA College of Southern Philippines',   'PERCENTAGE_100',  75.00, 100.00, 50.00, 50.00, 100.00, true, 2, 'Percentage grading scale from company scholarship report (SY 2024-2027).', NOW(), NOW()),
  (12, 'Mindanao Medical Foundation College',    'PERCENTAGE_100',  75.00, 100.00, 50.00, 50.00, 100.00, true, 2, 'Percentage grading scale from company scholarship report (SY 2025-2027).', NOW(), NOW())
ON CONFLICT (school_id) DO NOTHING;

INSERT INTO public.schools (
  school_id, school_name, school_code, address, is_active, grading_system_id, created_at, updated_at
)
VALUES
  (8,  'Holy Cross College of Calinan, Inc.',   'HCCC', 'Datu Abing St, Calinan District, Davao City, 8000 Davao del Sur',                 true, 8,  NOW(), NOW()),
  (9,  'Holy Cross of Davao College, Inc.',     'HCDC', 'Sta. Ana Ave, Poblacion District, Davao City, 8000 Davao del Sur',                true, 9,  NOW(), NOW()),
  (10, 'Davao Medical School Foundation, Inc.', 'DMSF', 'Medical School Dr, Bajada, Davao City, 8000 Davao del Sur',                       true, 10, NOW(), NOW()),
  (11, 'DMMA College of Southern Philippines',  'DMMA', 'Tigatto Rd, Buhangin, Davao City, 8000 Davao del Sur',                            true, 11, NOW(), NOW()),
  (12, 'Mindanao Medical Foundation College',   'MMFC', 'Philippine-Japan Friendship Hwy, Buhangin, Davao City, 8000 Davao del Sur',       true, 12, NOW(), NOW())
ON CONFLICT (school_id) DO NOTHING;

UPDATE public.schools SET grading_system_id = 6, updated_at = NOW() WHERE school_id = 6 AND (grading_system_id IS DISTINCT FROM 6);
UPDATE public.schools SET grading_system_id = 7, updated_at = NOW() WHERE school_id = 7 AND (grading_system_id IS DISTINCT FROM 7);

SELECT setval(pg_get_serial_sequence('public.school_grading_systems', 'school_id'), COALESCE((SELECT MAX(school_id) FROM public.school_grading_systems), 1), true);
SELECT setval(pg_get_serial_sequence('public.schools', 'school_id'), COALESCE((SELECT MAX(school_id) FROM public.schools), 1), true);

-- -----------------------------------------------------------------------------
-- 2. Insert Missing Academic Programs referenced in SCHOLARS.xlsx
-- -----------------------------------------------------------------------------
INSERT INTO public.academic_programs (program_code, program_name, category, description, is_active, created_at, updated_at)
VALUES
  ('BPED',      'Bachelor of Physical Education',                                       'College', 'Bachelor of Physical Education', true, NOW(), NOW()),
  ('BSCrim',    'BS Criminology',                                                       'College', 'Bachelor of Science in Criminology', true, NOW(), NOW()),
  ('BSMLS',     'BS Medical Laboratory Science',                                        'College', 'Bachelor of Science in Medical Laboratory Science', true, NOW(), NOW()),
  ('DMD',       'Doctor of Dental Medicine',                                            'College', 'Doctor of Dental Medicine', true, NOW(), NOW()),
  ('ABPsych',   'AB Psychology',                                                        'College', 'Bachelor of Arts in Psychology', true, NOW(), NOW()),
  ('BSBA-MM',   'BS Business Administration - Marketing Management',                    'College', 'Bachelor of Science in Business Administration major in Marketing Management', true, NOW(), NOW()),
  ('BSBA-FM',   'BS Business Administration - Financial Management',                    'College', 'Bachelor of Science in Business Administration major in Financial Management', true, NOW(), NOW()),
  ('BSBA-HRDM', 'BS Business Administration - Human Resource Development Management',   'College', 'Bachelor of Science in Business Administration major in Human Resource Development Management', true, NOW(), NOW())
ON CONFLICT (program_code) DO NOTHING;

SELECT setval(pg_get_serial_sequence('public.academic_programs', 'program_id'), COALESCE((SELECT MAX(program_id) FROM public.academic_programs), 1), true);

-- -----------------------------------------------------------------------------
-- 3. Onboard 13 College Scholars + Full Operational History (SY 2018-2027)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_user_id       INTEGER;
  v_profile_id    INTEGER;
  v_disb_id       INTEGER;
  v_enroll_id     INTEGER;
  v_program_id    INTEGER;
  v_pw_hash       CONSTANT TEXT := '$2b$10$heLAs6LTCs3wPBbdjDbsieILg2bYQ3EP9qqjcTQAT.6mUuAXrkUeK';
BEGIN

  -- ===========================================================================
  -- Scholar 01: Nikko Springael Bulfa (LBSP-2018-001)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'nikko.bulfa@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'nikko.bulfa@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2018-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2018-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Nikko Springael', NULL, 'Bulfa', NULL, 'Male',
      '09991000001', true, '2018-06-15 09:00:00'::timestamp,
      'Davao City, Davao del Sur', 'E. Jacinto St, Poblacion District, Davao City, 8000 Davao del Sur', 'LBSP-2018-001', NULL,
      'Academic Track', 'AB Psychology', 'Ateneo de Davao University', 4,
      'BASELINE_FROZEN', 4,
      '2019-06-15 09:00:00'::timestamp, 3, 'GRADUATED', 'Legacy college scholar record migrated from SY 2018-2019 company report.'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2018-06-15 09:00:00'::timestamp, '2018-06-15 09:00:00'::timestamp, '2018-06-15 09:00:00'::timestamp, '2018-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2018-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2018-001', 'SIGNED',
      '2018-06-15'::date, '2019-06-30'::date, '2018-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2015-2016', 'ABPsych', 'AB Psychology', 150.0,
      true, '2018-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2018-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '1st Semester', 40593.90, 'DV-2018-0001', 'Ateneo de Davao University', 'CHK-2018-0001',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2018-08-15'::date, '2018-09-05'::date, 'OR-2018-0001', '2018-09-05'::date, '2018-09-20'::timestamp,
      '2018-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2018-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '1st Semester', 4, true,
      21.0, 40593.90, '2018-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2018-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2018-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2018-2019', '1st Semester', '1st Semester', 1.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2018-12-15 10:00:00'::timestamp, '2018-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '2nd Semester', 46908.80, 'DV-2018-0002', 'Ateneo de Davao University', 'CHK-2018-0002',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-01-15'::date, '2019-02-05'::date, 'OR-2018-0002', '2019-02-05'::date, '2019-02-20'::timestamp,
      '2019-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '2nd Semester', 4, true,
      21.0, 46908.80, '2019-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2018-2019', '2nd Semester', '2nd Semester', 1.45, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-05-15 10:00:00'::timestamp, '2019-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 02: Paula Jean Secretaria (LBSP-2018-002)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'paula.secretaria@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'paula.secretaria@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2018-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2018-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Paula Jean', NULL, 'Secretaria', NULL, 'Female',
      '09991000002', true, '2018-06-15 09:00:00'::timestamp,
      'Downtown District, Davao City, Davao del Sur', '12 C. de Guzman St, Poblacion District, Davao City, 8000 Davao del Sur', 'LBSP-2018-002', NULL,
      'Academic Track', 'BS Medical Laboratory Science', 'San Pedro College', 6,
      'BASELINE_FROZEN', 4,
      '2022-06-30 09:00:00'::timestamp, 3, 'GRADUATED', 'Graduated June 2022 per SY 2021-2022 company report.'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2018-06-15 09:00:00'::timestamp, '2018-06-15 09:00:00'::timestamp, '2018-06-15 09:00:00'::timestamp, '2018-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2018-06-15 09:00:00'::timestamp, '2022-06-30 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2018-002', 'SIGNED',
      '2018-06-15'::date, '2022-06-30'::date, '2018-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', 'BSMLS', 'BS Medical Laboratory Science', 150.0,
      true, '2018-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2018-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '1st Semester', 31840.15, 'DV-2018-0003', 'San Pedro College', 'CHK-2018-0003',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2018-08-15'::date, '2018-09-05'::date, 'OR-2018-0003', '2018-09-05'::date, '2018-09-20'::timestamp,
      '2018-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2018-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '1st Semester', 1, true,
      21.0, 31840.15, '2018-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2018-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2018-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2018-2019', '1st Semester', '1st Semester', 91.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2018-12-15 10:00:00'::timestamp, '2018-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '2nd Semester', 37768.10, 'DV-2018-0004', 'San Pedro College', 'CHK-2018-0004',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-01-15'::date, '2019-02-05'::date, 'OR-2018-0004', '2019-02-05'::date, '2019-02-20'::timestamp,
      '2019-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', '2nd Semester', 1, true,
      21.0, 37768.10, '2019-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2018-2019', '2nd Semester', '2nd Semester', 92.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-05-15 10:00:00'::timestamp, '2019-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', 'Summer', 13227.65, 'DV-2018-0005', 'San Pedro College', 'CHK-2018-0005',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-06-05'::date, '2019-06-15'::date, 'OR-2018-0005', '2019-06-15'::date, '2019-06-25'::timestamp,
      '2019-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2018-2019', 'Summer', 1, true,
      9.0, 13227.65, '2019-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2018-2019', 'Summer', 'Summer', 91.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-07-25 10:00:00'::timestamp, '2019-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 37032.97, 'DV-2019-0006', 'San Pedro College', 'CHK-2019-0006',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-08-15'::date, '2019-09-05'::date, 'OR-2019-0006', '2019-09-05'::date, '2019-09-20'::timestamp,
      '2019-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 2, true,
      21.0, 37032.97, '2019-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', '1st Semester', 92.30, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-12-15 10:00:00'::timestamp, '2019-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 33622.27, 'DV-2019-0007', 'San Pedro College', 'CHK-2019-0007',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-01-15'::date, '2020-02-05'::date, 'OR-2019-0007', '2020-02-05'::date, '2020-02-20'::timestamp,
      '2020-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 2, true,
      21.0, 33622.27, '2020-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', '2nd Semester', 92.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-05-15 10:00:00'::timestamp, '2020-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', 'Summer', 9478.92, 'DV-2019-0008', 'San Pedro College', 'CHK-2019-0008',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-06-05'::date, '2020-06-15'::date, 'OR-2019-0008', '2020-06-15'::date, '2020-06-25'::timestamp,
      '2020-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', 'Summer', 2, true,
      9.0, 9478.92, '2020-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', 'Summer', 'Summer', 91.90, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-07-25 10:00:00'::timestamp, '2020-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 40286.37, 'DV-2020-0009', 'San Pedro College', 'CHK-2020-0009',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0009', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 3, true,
      21.0, 40286.37, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 93.10, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 40645.22, 'DV-2020-0010', 'San Pedro College', 'CHK-2020-0010',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0010', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 3, true,
      21.0, 40645.22, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 92.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 11269.36, 'DV-2020-0011', 'San Pedro College', 'CHK-2020-0011',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-06-05'::date, '2021-06-15'::date, 'OR-2020-0011', '2021-06-15'::date, '2021-06-25'::timestamp,
      '2021-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 3, true,
      9.0, 11269.36, '2021-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 'Summer', 92.40, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-07-25 10:00:00'::timestamp, '2021-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 43456.03, 'DV-2021-0012', 'San Pedro College', 'CHK-2021-0012',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0012', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 4, true,
      21.0, 43456.03, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 93.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 46430.85, 'DV-2021-0013', 'San Pedro College', 'CHK-2021-0013',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0013', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 4, true,
      21.0, 46430.85, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 93.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 03: Cyrelle Jean Cartin (LBSP-2019-003)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'cyrelle.cartin@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'cyrelle.cartin@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2019-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2019-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Cyrelle Jean', NULL, 'Cartin', NULL, 'Female',
      '09991000003', true, '2019-06-15 09:00:00'::timestamp,
      'Calinan District, Davao City, Davao del Sur', 'Datu Abing St, Calinan District, Davao City, 8000 Davao del Sur', 'LBSP-2019-003', NULL,
      'Academic Track', 'BS Business Administration - Marketing Management', 'Holy Cross College of Calinan, Inc.', 8,
      'BASELINE_FROZEN', 4,
      '2023-06-15 09:00:00'::timestamp, 3, 'GRADUATED', 'Completed 4th Year in SY 2022-2023 (also listed as Carten in SY 2022-2023 sheet).'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2019-06-15 09:00:00'::timestamp, '2023-06-15 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2019-003', 'SIGNED',
      '2019-06-15'::date, '2023-06-30'::date, '2019-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', 'BSBA-MM', 'BS Business Administration - Marketing Management', 150.0,
      true, '2019-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2019-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 15403.12, 'DV-2019-0014', 'Holy Cross College of Calinan, Inc.', 'CHK-2019-0014',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-08-15'::date, '2019-09-05'::date, 'OR-2019-0014', '2019-09-05'::date, '2019-09-20'::timestamp,
      '2019-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 1, true,
      21.0, 15403.12, '2019-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', '1st Semester', 91.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-12-15 10:00:00'::timestamp, '2019-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 15469.37, 'DV-2019-0015', 'Holy Cross College of Calinan, Inc.', 'CHK-2019-0015',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-01-15'::date, '2020-02-05'::date, 'OR-2019-0015', '2020-02-05'::date, '2020-02-20'::timestamp,
      '2020-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 1, true,
      21.0, 15469.37, '2020-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', '2nd Semester', 91.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-05-15 10:00:00'::timestamp, '2020-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 18831.82, 'DV-2020-0016', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0016',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0016', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 2, true,
      21.0, 18831.82, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 90.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 18419.54, 'DV-2020-0017', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0017',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0017', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 2, true,
      21.0, 18419.54, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 91.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 17016.40, 'DV-2021-0018', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0018',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0018', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 3, true,
      21.0, 17016.40, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 89.00, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 16629.57, 'DV-2021-0019', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0019',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0019', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 3, true,
      21.0, 16629.57, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 86.50, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 6154.17, 'DV-2022-0020', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0020',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0020', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 4, true,
      21.0, 6154.17, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 93.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 11082.16, 'DV-2022-0021', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0021',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0021', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 4, true,
      21.0, 11082.16, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 92.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 04: Alleah Fe Tiongson (LBSP-2019-004)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'alleah.tiongson@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'alleah.tiongson@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2019-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2019-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Alleah Fe', NULL, 'Tiongson', NULL, 'Female',
      '09991000004', true, '2019-06-15 09:00:00'::timestamp,
      'Calinan District, Davao City, Davao del Sur', 'Datu Abing St, Calinan District, Davao City, 8000 Davao del Sur', 'LBSP-2019-004', NULL,
      'Academic Track', 'Bachelor of Physical Education', 'Holy Cross College of Calinan, Inc.', 8,
      'BASELINE_FROZEN', 4,
      '2024-04-30 09:00:00'::timestamp, 3, 'GRADUATED', 'Graduated April 2024 per SY 2023-2024 company report (shifted from BSBA-HRDM to BPED in SY 2020-2021).'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2019-06-15 09:00:00'::timestamp, '2024-04-30 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2019-004', 'SIGNED',
      '2019-06-15'::date, '2024-06-30'::date, '2019-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'BPED', 'Bachelor of Physical Education', 150.0,
      true, '2019-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2019-06-15 09:00:00'::timestamp, NOW()
    );

    SELECT program_id INTO v_program_id FROM public.academic_programs WHERE program_code = 'BPED';
    INSERT INTO public.academic_change_requests (
      scholar_profile_id, change_type, current_course_of_study, current_school_id, current_school_name,
      requested_program_id, requested_course_of_study, requested_school_id, requested_school_name,
      effective_academic_year, effective_semester, reason, status, reviewed_by_user_id, reviewed_at,
      decision_notes, created_at, updated_at
    ) VALUES (
      v_profile_id, 'PROGRAM_SHIFT', 'BS Business Administration - Human Resource Development Management', 8, 'Holy Cross College of Calinan, Inc.',
      v_program_id, 'Bachelor of Physical Education', 8, 'Holy Cross College of Calinan, Inc.',
      '2020-2021', '1st Semester', 'Historical program shift from BSBA-HRDM to Bachelor of Physical Education (BPED) starting SY 2020-2021.', 'APPROVED', 3, '2020-08-10 09:00:00'::timestamp,
      'Approved and recorded from historical scholarship report.', '2020-08-10 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 38374.95, 'DV-2019-0022', 'Holy Cross College of Calinan, Inc.', 'CHK-2019-0022',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-08-15'::date, '2019-09-05'::date, 'OR-2019-0022', '2019-09-05'::date, '2019-09-20'::timestamp,
      '2019-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 1, true,
      21.0, 38374.95, '2019-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', '1st Semester', 91.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-12-15 10:00:00'::timestamp, '2019-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 34923.58, 'DV-2019-0023', 'Holy Cross College of Calinan, Inc.', 'CHK-2019-0023',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-01-15'::date, '2020-02-05'::date, 'OR-2019-0023', '2020-02-05'::date, '2020-02-20'::timestamp,
      '2020-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 1, true,
      21.0, 34923.58, '2020-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', '2nd Semester', 91.30, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-05-15 10:00:00'::timestamp, '2020-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 14521.60, 'DV-2020-0024', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0024',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0024', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 1, true,
      21.0, 14521.60, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 91.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 16058.71, 'DV-2020-0025', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0025',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0025', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 1, true,
      21.0, 16058.71, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 91.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 5738.23, 'DV-2020-0026', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0026',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-06-05'::date, '2021-06-15'::date, 'OR-2020-0026', '2021-06-15'::date, '2021-06-25'::timestamp,
      '2021-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 1, true,
      9.0, 5738.23, '2021-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 'Summer', 91.40, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-07-25 10:00:00'::timestamp, '2021-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 14489.84, 'DV-2021-0027', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0027',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0027', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 2, true,
      21.0, 14489.84, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 91.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 16348.25, 'DV-2021-0028', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0028',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0028', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 2, true,
      21.0, 16348.25, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 91.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 2814.05, 'DV-2021-0029', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0029',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-06-05'::date, '2022-06-15'::date, 'OR-2021-0029', '2022-06-15'::date, '2022-06-25'::timestamp,
      '2022-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 2, true,
      9.0, 2814.05, '2022-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 'Summer', 90.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-07-25 10:00:00'::timestamp, '2022-07-25 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 14023.62, 'DV-2022-0030', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0030',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0030', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 3, true,
      21.0, 14023.62, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 91.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 17277.75, 'DV-2022-0031', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0031',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0031', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 3, true,
      21.0, 17277.75, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 91.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 10233.35, 'DV-2023-0032', 'Holy Cross College of Calinan, Inc.', 'CHK-2023-0032',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0032', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 4, true,
      21.0, 10233.35, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 91.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 19302.56, 'DV-2023-0033', 'Holy Cross College of Calinan, Inc.', 'CHK-2023-0033',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-01-15'::date, '2024-02-05'::date, 'OR-2023-0033', '2024-02-05'::date, '2024-02-20'::timestamp,
      '2024-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 4, true,
      21.0, 19302.56, '2024-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', '2nd Semester', 91.33, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-05-15 10:00:00'::timestamp, '2024-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 05: Joyce Sunga (LBSP-2019-005)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'joyce.sunga@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'joyce.sunga@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2019-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2019-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Joyce', NULL, 'Sunga', NULL, 'Female',
      '09991000005', true, '2019-06-15 09:00:00'::timestamp,
      'Downtown District, Davao City, Davao del Sur', 'Bolton & Matina Campus, Davao City, 8000 Davao del Sur', 'LBSP-2019-005', NULL,
      'Academic Track', 'BS Criminology', 'University of Mindanao', 3,
      'BASELINE_FROZEN', 4,
      '2024-04-30 09:00:00'::timestamp, 3, 'GRADUATED', 'Graduated April 2024 per SY 2023-2024 company report.'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2019-06-15 09:00:00'::timestamp, '2024-04-30 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2019-005', 'SIGNED',
      '2019-06-15'::date, '2024-06-30'::date, '2019-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', 'BSCrim', 'BS Criminology', 150.0,
      true, '2019-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2019-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 23011.50, 'DV-2019-0034', 'University of Mindanao', 'CHK-2019-0034',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-08-15'::date, '2019-09-05'::date, 'OR-2019-0034', '2019-09-05'::date, '2019-09-20'::timestamp,
      '2019-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 1, true,
      21.0, 23011.50, '2019-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', '1st Semester', 3.55, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-12-15 10:00:00'::timestamp, '2019-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 21188.50, 'DV-2019-0035', 'University of Mindanao', 'CHK-2019-0035',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-01-15'::date, '2020-02-05'::date, 'OR-2019-0035', '2020-02-05'::date, '2020-02-20'::timestamp,
      '2020-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 1, true,
      21.0, 21188.50, '2020-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', '2nd Semester', 3.57, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-05-15 10:00:00'::timestamp, '2020-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.40%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 17972.50, 'DV-2020-0036', 'University of Mindanao', 'CHK-2020-0036',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0036', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 2, true,
      21.0, 17972.50, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 3.56, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.20%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 21087.00, 'DV-2020-0037', 'University of Mindanao', 'CHK-2020-0037',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0037', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 2, true,
      21.0, 21087.00, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 3.58, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.60%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 5071.25, 'DV-2020-0038', 'University of Mindanao', 'CHK-2020-0038',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-06-05'::date, '2021-06-15'::date, 'OR-2020-0038', '2021-06-15'::date, '2021-06-25'::timestamp,
      '2021-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 2, true,
      9.0, 5071.25, '2021-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 'Summer', 3.58, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-07-25 10:00:00'::timestamp, '2021-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.50%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 23079.50, 'DV-2021-0039', 'University of Mindanao', 'CHK-2021-0039',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0039', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 3, true,
      21.0, 23079.50, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 3.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 90.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 22886.00, 'DV-2021-0040', 'University of Mindanao', 'CHK-2021-0040',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0040', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 3, true,
      21.0, 22886.00, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 3.23, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 87.32%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 5112.50, 'DV-2021-0041', 'University of Mindanao', 'CHK-2021-0041',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-06-05'::date, '2022-06-15'::date, 'OR-2021-0041', '2022-06-15'::date, '2022-06-25'::timestamp,
      '2022-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 3, true,
      9.0, 5112.50, '2022-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 'Summer', 3.60, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-07-25 10:00:00'::timestamp, '2022-07-25 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 92.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 22573.00, 'DV-2022-0042', 'University of Mindanao', 'CHK-2022-0042',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0042', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 3, true,
      21.0, 22573.00, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 3.30, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 88.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 10374.00, 'DV-2022-0043', 'University of Mindanao', 'CHK-2022-0043',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0043', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 3, true,
      21.0, 10374.00, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 3.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 96.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 12445.50, 'DV-2023-0044', 'University of Mindanao', 'CHK-2023-0044',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0044', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 4, true,
      21.0, 12445.50, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 3.60, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~92.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 14520.00, 'DV-2023-0105', 'University of Mindanao', 'CHK-2023-0105',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-01-15'::date, '2024-02-05'::date, 'OR-2023-0105', '2024-02-05'::date, '2024-02-20'::timestamp,
      '2024-02-20'::timestamp, 2, 3, 'Estimated disbursement (fee blank in SCHOLARS.xlsx; graduated April 2024).', '2024-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 4, true,
      21.0, 14520.00, '2024-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', '2nd Semester', 3.65, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-05-15 10:00:00'::timestamp, '2024-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Graduating April 2024; estimated tuition disbursement added.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 06: Mary Ann Yana (LBSP-2019-006)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'maryann.yana@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'maryann.yana@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2019-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2019-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Mary Ann', NULL, 'Yana', NULL, 'Female',
      '09991000006', true, '2019-06-15 09:00:00'::timestamp,
      'Downtown District, Davao City, Davao del Sur', 'Bolton & Matina Campus, Davao City, 8000 Davao del Sur', 'LBSP-2019-006', NULL,
      'Academic Track', 'Bachelor of Secondary Education', 'University of Mindanao', 3,
      'BASELINE_FROZEN', 4,
      '2024-08-30 09:00:00'::timestamp, 3, 'GRADUATED', 'Graduated August 2024 (BSEd - English) per SY 2023-2024 company report.'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp, '2019-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2019-06-15 09:00:00'::timestamp, '2024-08-30 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2019-006', 'SIGNED',
      '2019-06-15'::date, '2024-06-30'::date, '2019-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', 'BSED', 'Bachelor of Secondary Education', 150.0,
      true, '2019-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2019-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 21760.00, 'DV-2019-0045', 'University of Mindanao', 'CHK-2019-0045',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2019-08-15'::date, '2019-09-05'::date, 'OR-2019-0045', '2019-09-05'::date, '2019-09-20'::timestamp,
      '2019-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2019-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', 1, true,
      21.0, 21760.00, '2019-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2019-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2019-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '1st Semester', '1st Semester', 3.55, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2019-12-15 10:00:00'::timestamp, '2019-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 20400.00, 'DV-2019-0046', 'University of Mindanao', 'CHK-2019-0046',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-01-15'::date, '2020-02-05'::date, 'OR-2019-0046', '2020-02-05'::date, '2020-02-20'::timestamp,
      '2020-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', 1, true,
      21.0, 20400.00, '2020-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2019-2020', '2nd Semester', '2nd Semester', 3.56, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-05-15 10:00:00'::timestamp, '2020-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.20%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 16209.50, 'DV-2020-0047', 'University of Mindanao', 'CHK-2020-0047',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0047', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 2, true,
      21.0, 16209.50, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 3.58, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.50%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 17932.00, 'DV-2020-0048', 'University of Mindanao', 'CHK-2020-0048',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0048', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 2, true,
      21.0, 17932.00, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 3.60, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~92.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 5371.25, 'DV-2020-0049', 'University of Mindanao', 'CHK-2020-0049',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-06-05'::date, '2021-06-15'::date, 'OR-2020-0049', '2021-06-15'::date, '2021-06-25'::timestamp,
      '2021-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 2, true,
      9.0, 5371.25, '2021-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 'Summer', 3.65, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-07-25 10:00:00'::timestamp, '2021-07-25 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 93.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 15427.75, 'DV-2021-0050', 'University of Mindanao', 'CHK-2021-0050',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0050', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 3, true,
      21.0, 15427.75, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 3.40, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 89.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 11734.00, 'DV-2021-0051', 'University of Mindanao', 'CHK-2021-0051',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0051', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 3, true,
      21.0, 11734.00, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 3.40, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 89.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 2789.75, 'DV-2021-0052', 'University of Mindanao', 'CHK-2021-0052',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-06-05'::date, '2022-06-15'::date, 'OR-2021-0052', '2022-06-15'::date, '2022-06-25'::timestamp,
      '2022-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 3, true,
      9.0, 2789.75, '2022-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 'Summer', 3.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-07-25 10:00:00'::timestamp, '2022-07-25 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 90.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 18833.00, 'DV-2022-0053', 'University of Mindanao', 'CHK-2022-0053',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0053', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 3, true,
      21.0, 18833.00, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 3.51, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 90.20%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 18833.00, 'DV-2022-0054', 'University of Mindanao', 'CHK-2022-0054',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0054', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 3, true,
      21.0, 18833.00, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 3.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 90.00%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 20567.50, 'DV-2023-0055', 'University of Mindanao', 'CHK-2023-0055',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0055', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 4, true,
      21.0, 20567.50, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 3.58, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness; Equivalent ~91.50%.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 16867.50, 'DV-2023-0056', 'University of Mindanao', 'CHK-2023-0056',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-01-15'::date, '2024-02-05'::date, 'OR-2023-0056', '2024-02-05'::date, '2024-02-20'::timestamp,
      '2024-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 4, true,
      21.0, 16867.50, '2024-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', '2nd Semester', 3.65, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-05-15 10:00:00'::timestamp, '2024-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx; Excel percentage: 93.00%.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 07: Ellaiza Badilla (LBSP-2020-007)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'ellaiza.badilla@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'ellaiza.badilla@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2020-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2020-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Ellaiza', 'B.', 'Badilla', NULL, 'Female',
      '09991000007', true, '2020-06-15 09:00:00'::timestamp,
      'Calinan District, Davao City, Davao del Sur', 'Datu Abing St, Calinan District, Davao City, 8000 Davao del Sur', 'LBSP-2020-007', NULL,
      'Academic Track', 'BS Business Administration - Marketing Management', 'Holy Cross College of Calinan, Inc.', 8,
      'BASELINE_FROZEN', 4,
      '2024-04-30 09:00:00'::timestamp, 3, 'GRADUATED', 'Graduated April 2024 per SY 2023-2024 company report (shifted from BPED to BSBA-MKTG in SY 2022-2023).'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2020-06-15 09:00:00'::timestamp, '2024-04-30 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2020-007', 'SIGNED',
      '2020-06-15'::date, '2024-06-30'::date, '2020-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'BSBA-MM', 'BS Business Administration - Marketing Management', 150.0,
      true, '2020-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2020-06-15 09:00:00'::timestamp, NOW()
    );

    SELECT program_id INTO v_program_id FROM public.academic_programs WHERE program_code = 'BSBA-MM';
    INSERT INTO public.academic_change_requests (
      scholar_profile_id, change_type, current_course_of_study, current_school_id, current_school_name,
      requested_program_id, requested_course_of_study, requested_school_id, requested_school_name,
      effective_academic_year, effective_semester, reason, status, reviewed_by_user_id, reviewed_at,
      decision_notes, created_at, updated_at
    ) VALUES (
      v_profile_id, 'PROGRAM_SHIFT', 'Bachelor of Physical Education', 8, 'Holy Cross College of Calinan, Inc.',
      v_program_id, 'BS Business Administration - Marketing Management', 8, 'Holy Cross College of Calinan, Inc.',
      '2022-2023', '1st Semester', 'Historical program shift from BPED to BSBA-MKTG starting SY 2022-2023.', 'APPROVED', 3, '2022-08-10 09:00:00'::timestamp,
      'Approved and recorded from historical scholarship report.', '2022-08-10 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 16434.66, 'DV-2020-0057', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0057',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0057', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 1, true,
      21.0, 16434.66, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 91.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 16058.71, 'DV-2020-0058', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0058',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0058', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 1, true,
      21.0, 16058.71, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 92.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 6041.83, 'DV-2020-0059', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0059',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-06-05'::date, '2021-06-15'::date, 'OR-2020-0059', '2021-06-15'::date, '2021-06-25'::timestamp,
      '2021-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 1, true,
      9.0, 6041.83, '2021-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 'Summer', 92.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-07-25 10:00:00'::timestamp, '2021-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 20000.00, 'DV-2021-0060', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0060',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0060', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 2, true,
      21.0, 20000.00, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 94.45, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 15946.77, 'DV-2021-0061', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0061',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0061', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 2, true,
      21.0, 15946.77, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 93.22, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 5907.93, 'DV-2021-0062', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0062',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-06-05'::date, '2022-06-15'::date, 'OR-2021-0062', '2022-06-15'::date, '2022-06-25'::timestamp,
      '2022-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 2, true,
      9.0, 5907.93, '2022-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', 'Summer', 'Summer', 92.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-07-25 10:00:00'::timestamp, '2022-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 17106.43, 'DV-2022-0063', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0063',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0063', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 3, true,
      21.0, 17106.43, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 90.43, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 16674.76, 'DV-2022-0064', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0064',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0064', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 3, true,
      21.0, 16674.76, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 92.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 10233.35, 'DV-2023-0065', 'Holy Cross College of Calinan, Inc.', 'CHK-2023-0065',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0065', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 4, true,
      21.0, 10233.35, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 92.30, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 19302.56, 'DV-2023-0066', 'Holy Cross College of Calinan, Inc.', 'CHK-2023-0066',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-01-15'::date, '2024-02-05'::date, 'OR-2023-0066', '2024-02-05'::date, '2024-02-20'::timestamp,
      '2024-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 4, true,
      21.0, 19302.56, '2024-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', '2nd Semester', 92.67, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-05-15 10:00:00'::timestamp, '2024-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 08: Gladys Cartin (LBSP-2020-008)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'gladys.cartin@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'gladys.cartin@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2020-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2020-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Gladys', NULL, 'Cartin', NULL, 'Female',
      '09991000008', true, '2020-06-15 09:00:00'::timestamp,
      'Calinan District, Davao City, Davao del Sur', 'Datu Abing St, Calinan District, Davao City, 8000 Davao del Sur', 'LBSP-2020-008', NULL,
      'Academic Track', 'Bachelor of Elementary Education', 'Holy Cross College of Calinan, Inc.', 8,
      'BASELINE_FROZEN', 4,
      '2024-04-30 09:00:00'::timestamp, 3, 'GRADUATED', 'Graduated April 2024 (BEED-GEN) per SY 2023-2024 company report (prior SHS rows excluded per college-only import).'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2020-06-15 09:00:00'::timestamp, '2024-04-30 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2020-008', 'SIGNED',
      '2020-06-15'::date, '2024-06-30'::date, '2020-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'BEED', 'Bachelor of Elementary Education', 150.0,
      true, '2020-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2020-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 21302.01, 'DV-2020-0067', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0067',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0067', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 1, true,
      21.0, 21302.01, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 90.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 16058.71, 'DV-2020-0068', 'Holy Cross College of Calinan, Inc.', 'CHK-2020-0068',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0068', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 1, true,
      21.0, 16058.71, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 91.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 17041.03, 'DV-2021-0069', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0069',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0069', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 2, true,
      21.0, 17041.03, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 90.43, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 19445.29, 'DV-2021-0070', 'Holy Cross College of Calinan, Inc.', 'CHK-2021-0070',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0070', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 2, true,
      21.0, 19445.29, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 90.60, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 19269.92, 'DV-2022-0071', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0071',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0071', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 3, true,
      21.0, 19269.92, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 89.00, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 17053.42, 'DV-2022-0072', 'Holy Cross College of Calinan, Inc.', 'CHK-2022-0072',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0072', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 3, true,
      21.0, 17053.42, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 90.88, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 11964.62, 'DV-2023-0073', 'Holy Cross College of Calinan, Inc.', 'CHK-2023-0073',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0073', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 4, true,
      21.0, 11964.62, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 90.90, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 17586.22, 'DV-2023-0074', 'Holy Cross College of Calinan, Inc.', 'CHK-2023-0074',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-01-15'::date, '2024-02-05'::date, 'OR-2023-0074', '2024-02-05'::date, '2024-02-20'::timestamp,
      '2024-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 4, true,
      21.0, 17586.22, '2024-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', '2nd Semester', 91.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-05-15 10:00:00'::timestamp, '2024-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 09: Febbie Bagamaspad (LBSP-2020-009)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'febbie.bagamaspad@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'febbie.bagamaspad@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2020-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2020-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Febbie', NULL, 'Bagamaspad', NULL, 'Female',
      '09991000009', true, '2020-06-15 09:00:00'::timestamp,
      'Downtown District, Davao City, Davao del Sur', 'Sta. Ana Ave, Poblacion District, Davao City, 8000 Davao del Sur', 'LBSP-2020-009', NULL,
      'Academic Track', 'BS Business Administration - Financial Management', 'Holy Cross of Davao College, Inc.', 9,
      'BASELINE_FROZEN', 2,
      '2023-06-15 09:00:00'::timestamp, 3, 'WITHDRAWN', 'No longer listed after 2nd Semester SY 2022-2023.'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp, '2020-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2020-06-15 09:00:00'::timestamp, '2023-06-15 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2020-009', 'SIGNED',
      '2020-06-15'::date, '2023-06-30'::date, '2020-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'BSBA-FM', 'BS Business Administration - Financial Management', 150.0,
      true, '2020-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2020-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 13250.80, 'DV-2020-0075', 'Holy Cross of Davao College, Inc.', 'CHK-2020-0075',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2020-08-15'::date, '2020-09-05'::date, 'OR-2020-0075', '2020-09-05'::date, '2020-09-20'::timestamp,
      '2020-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2020-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', 1, true,
      21.0, 13250.80, '2020-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2020-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2020-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '1st Semester', '1st Semester', 90.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2020-12-15 10:00:00'::timestamp, '2020-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 8091.60, 'DV-2020-0076', 'Holy Cross of Davao College, Inc.', 'CHK-2020-0076',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-01-15'::date, '2021-02-05'::date, 'OR-2020-0076', '2021-02-05'::date, '2021-02-20'::timestamp,
      '2021-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', 1, true,
      21.0, 8091.60, '2021-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', '2nd Semester', '2nd Semester', 90.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-05-15 10:00:00'::timestamp, '2021-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 7037.60, 'DV-2020-0077', 'Holy Cross of Davao College, Inc.', 'CHK-2020-0077',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-06-05'::date, '2021-06-15'::date, 'OR-2020-0077', '2021-06-15'::date, '2021-06-25'::timestamp,
      '2021-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 1, true,
      9.0, 7037.60, '2021-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2020-2021', 'Summer', 'Summer', 90.60, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-07-25 10:00:00'::timestamp, '2021-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 18354.07, 'DV-2021-0078', 'Holy Cross of Davao College, Inc.', 'CHK-2021-0078',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2021-08-15'::date, '2021-09-05'::date, 'OR-2021-0078', '2021-09-05'::date, '2021-09-20'::timestamp,
      '2021-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2021-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', 2, true,
      21.0, 18354.07, '2021-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2021-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2021-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '1st Semester', '1st Semester', 88.00, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2021-12-15 10:00:00'::timestamp, '2021-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 16848.17, 'DV-2021-0079', 'Holy Cross of Davao College, Inc.', 'CHK-2021-0079',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-01-15'::date, '2022-02-05'::date, 'OR-2021-0079', '2022-02-05'::date, '2022-02-20'::timestamp,
      '2022-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', 2, true,
      21.0, 16848.17, '2022-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2021-2022', '2nd Semester', '2nd Semester', 90.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-05-15 10:00:00'::timestamp, '2022-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 21117.66, 'DV-2022-0080', 'Holy Cross of Davao College, Inc.', 'CHK-2022-0080',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0080', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 2, true,
      21.0, 21117.66, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 90.40, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 21117.66, 'DV-2022-0081', 'Holy Cross of Davao College, Inc.', 'CHK-2022-0081',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0081', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 2, true,
      21.0, 21117.66, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 90.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 10: Rodelyn Pingca (LBSP-2022-010)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'rodelyn.pingca@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'rodelyn.pingca@viascholar.demo', v_pw_hash, 'SCHOLAR', false, true, '2022-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2022-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Rodelyn', NULL, 'Pingca', NULL, 'Female',
      '09991000010', true, '2022-06-15 09:00:00'::timestamp,
      'Downtown District, Davao City, Davao del Sur', 'Sta. Ana Ave, Poblacion District, Davao City, 8000 Davao del Sur', 'LBSP-2022-010', NULL,
      'Academic Track', 'Bachelor of Elementary Education', 'Holy Cross of Davao College, Inc.', 9,
      'DISCONTINUED', 2,
      '2024-01-15 09:00:00'::timestamp, 3, 'FAILED_SECOND_CHANCE', 'Discontinued after SY 2023-2024 1st Semester when reported grade fell to 85.43% (below 90% retention mark).'
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2022-06-15 09:00:00'::timestamp, '2022-06-15 09:00:00'::timestamp, '2022-06-15 09:00:00'::timestamp, '2022-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2022-06-15 09:00:00'::timestamp, '2024-01-15 09:00:00'::timestamp
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2022-010', 'TERMINATED',
      '2022-06-15'::date, '2024-06-30'::date, '2022-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', 'BEED', 'Bachelor of Elementary Education', 150.0,
      true, '2022-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2022-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 23160.08, 'DV-2022-0082', 'Holy Cross of Davao College, Inc.', 'CHK-2022-0082',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0082', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 1, true,
      21.0, 23160.08, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 90.63, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 23000.00, 'DV-2022-0083', 'Holy Cross of Davao College, Inc.', 'CHK-2022-0083',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0083', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 2, true,
      21.0, 23000.00, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 90.63, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 23857.64, 'DV-2023-0084', 'Holy Cross of Davao College, Inc.', 'CHK-2023-0084',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0084', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 2, true,
      21.0, 23857.64, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 85.43, 'FLAGGED', 'BELOW_PASSING_MARK', false,
      'DENIED', 'Unable to meet 90% grade retention mark (85.43%).', '2023-12-15 10:00:00'::timestamp, '2024-01-15 09:00:00'::timestamp, 3, 'Disqualified per grade retention policy (85.43% < 90.00%).',
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 11: Kriziah Allene Aca-ac (LBSP-2022-011)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'kriziah.acaac@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'kriziah.acaac@viascholar.demo', v_pw_hash, 'SCHOLAR', true, true, '2022-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2022-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Kriziah Allene', 'D.', 'Aca-ac', NULL, 'Female',
      '09991000011', true, '2022-06-15 09:00:00'::timestamp,
      'Davao City, Davao del Sur', 'Philippine-Japan Friendship Hwy, Buhangin, Davao City, 8000 Davao del Sur', 'LBSP-2022-011', NULL,
      'Financial Assistance', 'Doctor of Dental Medicine', 'Mindanao Medical Foundation College', 12,
      'BASELINE_FROZEN', 5,
      NULL, NULL, NULL, NULL
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2022-06-15 09:00:00'::timestamp, '2022-06-15 09:00:00'::timestamp, '2022-06-15 09:00:00'::timestamp, '2022-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2022-06-15 09:00:00'::timestamp, NULL
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2022-011', 'SIGNED',
      '2022-06-15'::date, '2027-06-30'::date, '2022-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', 'DMD', 'Doctor of Dental Medicine', 180.0,
      true, '2022-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2022-06-15 09:00:00'::timestamp, NOW()
    );

    SELECT program_id INTO v_program_id FROM public.academic_programs WHERE program_code = 'DMD';
    INSERT INTO public.academic_change_requests (
      scholar_profile_id, change_type, current_course_of_study, current_school_id, current_school_name,
      requested_program_id, requested_course_of_study, requested_school_id, requested_school_name,
      effective_academic_year, effective_semester, reason, status, reviewed_by_user_id, reviewed_at,
      decision_notes, created_at, updated_at
    ) VALUES (
      v_profile_id, 'SCHOOL_TRANSFER', 'Doctor of Dental Medicine', 10, 'Davao Medical School Foundation, Inc.',
      v_program_id, 'Doctor of Dental Medicine', 12, 'Mindanao Medical Foundation College',
      '2025-2026', '2nd Semester', 'Historical school transfer from DMSF to Mindanao Medical Foundation College (MMFC) in 2nd Semester SY 2025-2026.', 'APPROVED', 3, '2026-01-10 09:00:00'::timestamp,
      'Approved and recorded from historical scholarship report.', '2026-01-10 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 27438.70, 'DV-2022-0085', 'Davao Medical School Foundation, Inc.', 'CHK-2022-0085',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2022-08-15'::date, '2022-09-05'::date, 'OR-2022-0085', '2022-09-05'::date, '2022-09-20'::timestamp,
      '2022-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2022-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', 1, true,
      21.0, 27438.70, '2022-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2022-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2022-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '1st Semester', '1st Semester', 92.33, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2022-12-15 10:00:00'::timestamp, '2022-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 37562.12, 'DV-2022-0086', 'Davao Medical School Foundation, Inc.', 'CHK-2022-0086',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-01-15'::date, '2023-02-05'::date, 'OR-2022-0086', '2023-02-05'::date, '2023-02-20'::timestamp,
      '2023-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', 1, true,
      21.0, 37562.12, '2023-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2022-2023', '2nd Semester', '2nd Semester', 90.11, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-05-15 10:00:00'::timestamp, '2023-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 26293.48, 'DV-2023-0087', 'Davao Medical School Foundation, Inc.', 'CHK-2023-0087',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2023-08-15'::date, '2023-09-05'::date, 'OR-2023-0087', '2023-09-05'::date, '2023-09-20'::timestamp,
      '2023-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2023-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', 2, true,
      21.0, 26293.48, '2023-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2023-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2023-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '1st Semester', '1st Semester', 85.85, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2023-12-15 10:00:00'::timestamp, '2023-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 66647.00, 'DV-2023-0088', 'Davao Medical School Foundation, Inc.', 'CHK-2023-0088',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-01-15'::date, '2024-02-05'::date, 'OR-2023-0088', '2024-02-05'::date, '2024-02-20'::timestamp,
      '2024-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', 2, true,
      21.0, 66647.00, '2024-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2023-2024', '2nd Semester', '2nd Semester', 85.80, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-05-15 10:00:00'::timestamp, '2024-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', 72715.00, 'DV-2024-0089', 'Davao Medical School Foundation, Inc.', 'CHK-2024-0089',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-08-15'::date, '2024-09-05'::date, 'OR-2024-0089', '2024-09-05'::date, '2024-09-20'::timestamp,
      '2024-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', 3, true,
      21.0, 72715.00, '2024-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', '1st Semester', 85.14, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-12-15 10:00:00'::timestamp, '2024-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', 50779.00, 'DV-2024-0090', 'Davao Medical School Foundation, Inc.', 'CHK-2024-0090',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2025-01-15'::date, '2025-02-05'::date, 'OR-2024-0090', '2025-02-05'::date, '2025-02-20'::timestamp,
      '2025-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2025-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', 3, true,
      21.0, 50779.00, '2025-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2025-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2025-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', '2nd Semester', 86.33, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2025-05-15 10:00:00'::timestamp, '2025-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', 75482.00, 'DV-2025-0091', 'Davao Medical School Foundation, Inc.', 'CHK-2025-0091',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2025-08-15'::date, '2025-09-05'::date, 'OR-2025-0091', '2025-09-05'::date, '2025-09-20'::timestamp,
      '2025-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2025-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', 4, true,
      21.0, 75482.00, '2025-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2025-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2025-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', '1st Semester', 85.00, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2025-12-15 10:00:00'::timestamp, '2025-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', 27194.61, 'DV-2025-0092', 'Mindanao Medical Foundation College', 'CHK-2025-0092',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-01-15'::date, '2026-02-05'::date, 'OR-2025-0092', '2026-02-05'::date, '2026-02-20'::timestamp,
      '2026-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', 4, true,
      21.0, 27194.61, '2026-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', '2nd Semester', 90.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-05-15 10:00:00'::timestamp, '2026-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', 24223.21, 'DV-2026-0093', 'Mindanao Medical Foundation College', 'CHK-2026-0093',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-08-18'::date, '2026-09-05'::date, 'OR-2026-0093', '2026-09-05'::date, '2026-09-20'::timestamp,
      '2026-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-08-18'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', 5, true,
      21.0, 24223.21, '2026-08-18'::date, 'APPROVED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-08-18'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-08-18'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', '1st Semester', 93.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-11-20 10:00:00'::timestamp, '2026-11-20 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 12: Shaye Mari Aposacas (LBSP-2024-012)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'shaye.aposacas@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'shaye.aposacas@viascholar.demo', v_pw_hash, 'SCHOLAR', true, true, '2024-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2024-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Shaye Mari', NULL, 'Aposacas', NULL, 'Female',
      '09991000012', true, '2024-06-15 09:00:00'::timestamp,
      'Calinan District, Davao City, Davao del Sur', 'Datu Abing St, Calinan District, Davao City, 8000 Davao del Sur', 'LBSP-2024-012', NULL,
      'Academic Track', 'Bachelor of Physical Education', 'Holy Cross College of Calinan, Inc.', 8,
      'BASELINE_FROZEN', 3,
      NULL, NULL, NULL, NULL
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2024-06-15 09:00:00'::timestamp, '2024-06-15 09:00:00'::timestamp, '2024-06-15 09:00:00'::timestamp, '2024-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2024-06-15 09:00:00'::timestamp, NULL
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2024-012', 'SIGNED',
      '2024-06-15'::date, '2027-06-30'::date, '2024-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', 'BPED', 'Bachelor of Physical Education', 150.0,
      true, '2024-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2024-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', 23857.64, 'DV-2024-0094', 'Holy Cross College of Calinan, Inc.', 'CHK-2024-0094',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-08-15'::date, '2024-09-05'::date, 'OR-2024-0094', '2024-09-05'::date, '2024-09-20'::timestamp,
      '2024-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', 1, true,
      21.0, 23857.64, '2024-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', '1st Semester', 89.67, 'APPROVED', 'BELOW_PASSING_MARK', false,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-12-15 10:00:00'::timestamp, '2024-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', 21145.10, 'DV-2024-0095', 'Holy Cross College of Calinan, Inc.', 'CHK-2024-0095',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2025-01-15'::date, '2025-02-05'::date, 'OR-2024-0095', '2025-02-05'::date, '2025-02-20'::timestamp,
      '2025-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2025-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', 1, true,
      21.0, 21145.10, '2025-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2025-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2025-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', '2nd Semester', 93.67, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2025-05-15 10:00:00'::timestamp, '2025-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', 24245.69, 'DV-2025-0096', 'Holy Cross College of Calinan, Inc.', 'CHK-2025-0096',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2025-08-15'::date, '2025-09-05'::date, 'OR-2025-0096', '2025-09-05'::date, '2025-09-20'::timestamp,
      '2025-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2025-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', 2, true,
      21.0, 24245.69, '2025-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2025-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2025-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', '1st Semester', 93.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2025-12-15 10:00:00'::timestamp, '2025-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', 37527.00, 'DV-2025-0097', 'Holy Cross College of Calinan, Inc.', 'CHK-2025-0097',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-01-15'::date, '2026-02-05'::date, 'OR-2025-0097', '2026-02-05'::date, '2026-02-20'::timestamp,
      '2026-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', 2, true,
      21.0, 37527.00, '2026-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', '2nd Semester', 91.35, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-05-15 10:00:00'::timestamp, '2026-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', 'Summer', 6495.61, 'DV-2025-0098', 'Holy Cross College of Calinan, Inc.', 'CHK-2025-0098',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-06-05'::date, '2026-06-15'::date, 'OR-2025-0098', '2026-06-15'::date, '2026-06-25'::timestamp,
      '2026-06-25'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-06-05'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', 'Summer', 2, true,
      9.0, 6495.61, '2026-06-05'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-06-05'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-06-05'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', 'Summer', 'Summer', 91.80, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-07-25 10:00:00'::timestamp, '2026-07-25 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', 26657.48, 'DV-2026-0099', 'Holy Cross College of Calinan, Inc.', 'CHK-2026-0099',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-08-18'::date, '2026-09-05'::date, 'OR-2026-0099', '2026-09-05'::date, '2026-09-20'::timestamp,
      '2026-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-08-18'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', 3, true,
      21.0, 26657.48, '2026-08-18'::date, 'APPROVED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-08-18'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-08-18'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', '1st Semester', 92.50, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-11-20 10:00:00'::timestamp, '2026-11-20 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;

  -- ===========================================================================
  -- Scholar 13: Zoe Tiffyberyl Tero (LBSP-2024-013)
  -- ===========================================================================
  SELECT user_id INTO v_user_id FROM public.users WHERE email = 'zoe.tero@viascholar.demo';
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, role, is_active, is_email_verified, email_verified_at,
      two_factor_enabled, two_factor_method, email_notifs, sms_notifs, forum_digest, public_profile,
      created_at, updated_at
    ) VALUES (
      'zoe.tero@viascholar.demo', v_pw_hash, 'SCHOLAR', true, true, '2024-06-15 09:00:00'::timestamp,
      false, NULL, false, false, false, true,
      '2024-06-15 09:00:00'::timestamp, NOW()
    ) RETURNING user_id INTO v_user_id;

    INSERT INTO public.scholar_profiles (
      user_id, first_name, middle_name, last_name, suffix, gender,
      phone_number, is_phone_verified, phone_verified_at,
      student_address, school_address, student_number, relative_employee,
      scholarship_track, course_of_study, school_name, school_id,
      academic_baseline_status, current_year_level,
      archived_at, archived_by_user_id, archive_reason, archive_notes
    ) VALUES (
      v_user_id, 'Zoe Tiffyberyl', NULL, 'Tero', NULL, 'Female',
      '09991000013', true, '2024-06-15 09:00:00'::timestamp,
      'Downtown District, Davao City, Davao del Sur', 'Tigatto Rd, Buhangin, Davao City, 8000 Davao del Sur', 'LBSP-2024-013', NULL,
      'Academic Track', 'BS Hospitality Management', 'DMMA College of Southern Philippines', 11,
      'BASELINE_FROZEN', 3,
      NULL, NULL, NULL, NULL
    ) RETURNING profile_id INTO v_profile_id;

    INSERT INTO public.applications (
      scholar_profile_id, reviewed_by_employee_id, status, stage,
      submitted_at, stage_updated_at, decision_at, verified_at, provider_notes, closed_at, archived_at
    ) VALUES (
      v_profile_id, 2, 'APPROVED', 'APPROVED',
      '2024-06-15 09:00:00'::timestamp, '2024-06-15 09:00:00'::timestamp, '2024-06-15 09:00:00'::timestamp, '2024-06-15 09:00:00'::timestamp,
      'Onboarded from SY 2018-2027 historical scholarship summary report.', '2024-06-15 09:00:00'::timestamp, NULL
    );

    INSERT INTO public.contracts (
      scholar_profile_id, signed_by_user_id, contract_number, status,
      effective_date, expiry_date, signed_at, version
    ) VALUES (
      v_profile_id, v_user_id, 'CTR-LBSP-2024-013', 'SIGNED',
      '2024-06-15'::date, '2027-06-30'::date, '2024-06-15 09:00:00'::timestamp, 1
    );

    INSERT INTO public.scholar_prospectus (
      scholar_profile_id, curriculum_year, course_code, course_name, total_units,
      is_frozen, frozen_at, frozen_by_employee_id, status, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', 'BSHM', 'BS Hospitality Management', 150.0,
      true, '2024-06-15 09:00:00'::timestamp, 2, 'FROZEN', '2024-06-15 09:00:00'::timestamp, NOW()
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', 35777.12, 'DV-2024-0100', 'DMMA College of Southern Philippines', 'CHK-2024-0100',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2024-08-15'::date, '2024-09-05'::date, 'OR-2024-0100', '2024-09-05'::date, '2024-09-20'::timestamp,
      '2024-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2024-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', 1, true,
      21.0, 35777.12, '2024-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2024-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2024-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2024-2025', '1st Semester', '1st Semester', 92.60, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2024-12-15 10:00:00'::timestamp, '2024-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', 43495.58, 'DV-2024-0101', 'DMMA College of Southern Philippines', 'CHK-2024-0101',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2025-01-15'::date, '2025-02-05'::date, 'OR-2024-0101', '2025-02-05'::date, '2025-02-20'::timestamp,
      '2025-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2025-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', 1, true,
      21.0, 43495.58, '2025-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2025-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2025-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2024-2025', '2nd Semester', '2nd Semester', 94.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2025-05-15 10:00:00'::timestamp, '2025-05-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', 37798.71, 'DV-2025-0102', 'DMMA College of Southern Philippines', 'CHK-2025-0102',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2025-08-15'::date, '2025-09-05'::date, 'OR-2025-0102', '2025-09-05'::date, '2025-09-20'::timestamp,
      '2025-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2025-08-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', 2, true,
      21.0, 37798.71, '2025-08-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2025-08-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2025-08-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', '1st Semester', '1st Semester', 93.00, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2025-12-15 10:00:00'::timestamp, '2025-12-15 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', 21242.62, 'DV-2025-0103', 'DMMA College of Southern Philippines', 'CHK-2025-0103',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-01-15'::date, '2026-02-05'::date, 'OR-2025-0103', '2026-02-05'::date, '2026-02-20'::timestamp,
      '2026-02-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-01-15'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', 2, true,
      21.0, 21242.62, '2026-01-15'::date, 'COMPLETED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-01-15'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-01-15'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2025-2026', '2nd Semester', '2nd Semester', 93.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-05-15 10:00:00'::timestamp, '2026-05-15 10:00:00'::timestamp, 2, 'Synthetic passing grade for historical term completeness.'
    );

    INSERT INTO public.disbursements (
      scholar_profile_id, academic_year, semester, amount, voucher_number, check_payee, check_number,
      payment_method, status, date_issued, date_claimed, or_number, or_payment_date, or_verified_at,
      settled_at, settled_by_employee_id, approved_by_employee_id, remarks, created_at, updated_at
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', 34223.13, 'DV-2026-0104', 'DMMA College of Southern Philippines', 'CHK-2026-0104',
      'DIRECT_TO_SCHOOL_CHECK', 'SETTLED', '2026-08-18'::date, '2026-09-05'::date, 'OR-2026-0104', '2026-09-05'::date, '2026-09-20'::timestamp,
      '2026-09-20'::timestamp, 2, 3, 'Settled per SY 2018-2027 scholarship summary report.', '2026-08-18'::timestamp, NOW()
    ) RETURNING disbursement_id INTO v_disb_id;
    INSERT INTO public.term_enrollments (
      scholar_profile_id, academic_year, semester, year_level, is_consolidated,
      total_units, total_assessment, assessment_date, status, audit_flags,
      reviewed_by_employee_id, reviewed_at, coordinator_notes, disbursement_id, created_at, updated_at
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', 3, true,
      21.0, 34223.13, '2026-08-18'::date, 'APPROVED', '["ALL_CLEARED"]'::jsonb,
      2, '2026-08-18'::timestamp, 'Legacy term record from company report.', v_disb_id, '2026-08-18'::timestamp, NOW()
    ) RETURNING enrollment_id INTO v_enroll_id;
    INSERT INTO public.grade_reports (
      scholar_profile_id, academic_year, semester, term, gpa, status, evaluation_flag, is_eligible,
      appeal_status, appeal_notes, appeal_submitted_at, appeal_reviewed_at, appeal_reviewed_by_employee_id, appeal_decision_notes,
      term_enrollment_id, submitted_at, reviewed_at, reviewed_by_employee_id, remarks
    ) VALUES (
      v_profile_id, '2026-2027', '1st Semester', '1st Semester', 94.20, 'APPROVED', 'CLEARED', true,
      'NONE', NULL, NULL, NULL, NULL, NULL,
      v_enroll_id, '2026-11-20 10:00:00'::timestamp, '2026-11-20 10:00:00'::timestamp, 2, 'Recorded in SCHOLARS.xlsx.'
    );

  END IF;
END $$;

COMMIT;

-- =============================================================================
-- 4. POST-IMPORT VERIFICATION QUERY (Run separately to confirm counts & totals)
-- =============================================================================
/*
SELECT
  (SELECT COUNT(*) FROM public.users WHERE email LIKE '%@viascholar.demo') AS onboarded_users,
  (SELECT COUNT(*) FROM public.scholar_profiles WHERE student_number LIKE 'LBSP-%') AS onboarded_profiles,
  (SELECT COUNT(*) FROM public.term_enrollments te JOIN public.scholar_profiles sp ON sp.profile_id = te.scholar_profile_id WHERE sp.student_number LIKE 'LBSP-%') AS onboarded_enrollments,
  (SELECT COUNT(*) FROM public.grade_reports gr JOIN public.scholar_profiles sp ON sp.profile_id = gr.scholar_profile_id WHERE sp.student_number LIKE 'LBSP-%') AS onboarded_grade_reports,
  (SELECT COUNT(*) FROM public.disbursements d JOIN public.scholar_profiles sp ON sp.profile_id = d.scholar_profile_id WHERE sp.student_number LIKE 'LBSP-%') AS onboarded_disbursements,
  (SELECT SUM(d.amount) FROM public.disbursements d JOIN public.scholar_profiles sp ON sp.profile_id = d.scholar_profile_id WHERE sp.student_number LIKE 'LBSP-%') AS total_disbursed_php;
*/

-- =============================================================================
-- 5. SAFE ROLLBACK / CLEANUP SNIPPET (Only run if you need to undo this import)
-- =============================================================================
/*
BEGIN;
DELETE FROM public.users WHERE email LIKE '%@viascholar.demo';
COMMIT;
*/
