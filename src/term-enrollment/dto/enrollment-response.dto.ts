export interface SubjectAuditDetail {
  subject_code: string;
  descriptive_title: string;
  units: number;
  section?: string;
  schedule?: string;
  room?: string;
  status: 'ON_TRACK' | 'OFF_TRACK' | 'PREREQUISITE_CLEARED' | 'MISSING_PREREQUISITE';
  curriculum_subject_id?: number;
  unmet_prerequisites?: string[];
  remarks?: string;
}

export interface CrossDocReconciliationResult {
  is_match: boolean;
  student_id_match?: boolean;
  student_name_match?: boolean;
  academic_year_match?: boolean;
  semester_match?: boolean;
  confidence_score: number;
  mismatches: string[];
}

export interface EnrollmentAuditResult {
  all_cleared: boolean;
  flags: string[];
  total_units: number;
  overload_flag?: boolean;
  underload_flag?: boolean;
  subjects_audit: SubjectAuditDetail[];
  cross_doc_reconciliation?: CrossDocReconciliationResult;
}

export interface TermEnrollmentResponse {
  enrollment_id: number;
  scholar_profile_id: number;
  academic_year: string;
  semester: string;
  year_level: number;
  is_consolidated: boolean;
  cor_document_id?: number | null;
  soa_document_id?: number | null;
  total_units: number;
  total_assessment: number;
  assessment_date?: string | null;
  status: string;
  audit_flags?: string[] | null;
  enrolled_subjects?: any;
  billing_breakdown?: any;
  cross_doc_reconciliation?: any;
  reviewed_by_employee_id?: number | null;
  reviewed_at?: string | null;
  coordinator_notes?: string | null;
  disbursement_id?: number | null;
  created_at: string;
  updated_at: string;
}
