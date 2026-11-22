import {
  academicYearsMatchForTerm,
  findMatchingTermEnrollment,
  normalizeAcademicYear,
  normalizeSemester,
} from '../../documents/utils/academic-term.util.js';
import type { DeadlineRequirementType } from '../dto/deadline.dto.js';

export type DeadlineComplianceStatus =
  | 'SUBMITTED'
  | 'CURRENTLY_ENROLLED'
  | 'NEEDS_ACTION'
  | 'UPCOMING'
  | 'NOT_SUBMITTED'
  | 'OVERDUE'
  | 'EXEMPT'
  | 'NOT_APPLICABLE';

export interface DeadlineRecordLike {
  deadline_id: number;
  requirement_type: string;
  academic_year: string;
  semester: string;
  school_id: number | null;
  school?: {
    school_id?: number;
    school_name: string;
    school_code?: string | null;
  } | null;
  due_date: Date | string;
  grace_period_days: number;
  is_optional_term: boolean;
  title?: string | null;
  instructions?: string | null;
  is_active: boolean;
}

export type DeadlineSubmissionStage =
  | 'PENDING_AUDIT'
  | 'VERIFIED_READY'
  | 'ENDORSED'
  | 'NEEDS_REVISION'
  | 'REJECTED';

export interface DeadlineSubmissionSummary {
  kind: 'ENROLLMENT' | 'GRADES';
  enrollment_id?: number | null;
  grade_report_id?: number | null;
  grade_document_id?: number | null;
  raw_status: string;
  review_stage: DeadlineSubmissionStage;
  total_assessment?: number | null;
  total_units?: number | null;
  audit_flags_count?: number;
  submitted_at?: string | null;
}

export interface ScholarComplianceInput {
  profile_id: number;
  user_id: number;
  first_name: string;
  last_name: string;
  student_number?: string | null;
  course_of_study?: string | null;
  current_year_level?: number | null;
  school_id?: number | null;
  school_name?: string | null;
  school?: { school_id?: number; school_name: string } | null;
  school_grading_system?: { school_id?: number; school_name: string } | null;
  phone_number?: string | null;
  user?: { email?: string | null } | null;
  prospectus?: {
    is_frozen?: boolean;
    subjects?: Array<{
      year_level?: number | null;
      semester?: string | null;
      status?: string | null;
    }>;
  } | null;
  enrollments?: Array<{
    enrollment_id: number;
    academic_year: string;
    semester: string;
    status: string;
    cor_document_id?: number | null;
    soa_document_id?: number | null;
    total_assessment?: unknown;
    total_units?: unknown;
    audit_flags?: unknown;
    created_at?: Date | string | null;
    updated_at?: Date | string | null;
  }>;
  grade_reports?: Array<{
    report_id: number;
    document_id?: number | null;
    academic_year: string;
    semester: string;
    status: string;
    submitted_at?: Date | string | null;
  }>;
  documents?: Array<{
    document_id: number;
    document_type?: string | null;
    status: string;
    confirmed_data?: unknown;
    extracted_data?: unknown;
    uploaded_at?: Date | string | null;
    created_at?: Date | string | null;
    verified_at?: Date | string | null;
  }>;
}

export interface EvaluationResult {
  status: DeadlineComplianceStatus;
  status_detail: string;
  effective_due_date: string;
  days_remaining: number;
  days_overdue: number;
  submission?: DeadlineSubmissionSummary | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function stripSchoolParens(name?: string | null): string {
  return (name || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[()]/g, '')
    .trim()
    .toLowerCase();
}

export function normalizeSchoolName(name?: string | null): string {
  return stripSchoolParens(name);
}

export function resolveScholarSchoolName(
  scholar: Pick<
    ScholarComplianceInput,
    'school_name' | 'school_grading_system' | 'school'
  >,
): string {
  return (
    scholar.school_name?.trim() ||
    scholar.school_grading_system?.school_name?.trim() ||
    scholar.school?.school_name?.trim() ||
    'Unassigned'
  );
}

export function normalizeDueDateInput(raw: string): Date {
  const trimmed = (raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T23:59:59.999+08:00`);
  }
  return new Date(trimmed);
}

export function getRequirementLabel(reqType: string): string {
  return reqType === 'GRADES'
    ? 'Term Grades (CCG / Report Card)'
    : 'Start-of-Term Enrollment (COR & SOA)';
}

export function getRequirementActionPath(reqType: string): string {
  return reqType === 'GRADES' ? '/ScholarGrade' : '/scholar-enrollment';
}

export function scholarMatchesDeadlineSchool(
  scholar: Pick<
    ScholarComplianceInput,
    'school_id' | 'school_name' | 'school_grading_system'
  >,
  deadline: Pick<DeadlineRecordLike, 'school_id' | 'school'>,
): boolean {
  if (deadline.school_id === null || deadline.school_id === undefined) {
    return false;
  }
  const scholarSchoolName =
    scholar.school_name?.trim() ||
    scholar.school_grading_system?.school_name?.trim() ||
    '';
  if (scholarSchoolName && deadline.school?.school_name) {
    return (
      stripSchoolParens(scholarSchoolName) ===
      stripSchoolParens(deadline.school.school_name)
    );
  }
  if (scholar.school_id && scholar.school_id === deadline.school_id) {
    return true;
  }
  return false;
}

export function resolveEffectiveDeadline<T extends DeadlineRecordLike>(
  deadlines: T[],
  requirementType: DeadlineRequirementType,
  scholar: Pick<
    ScholarComplianceInput,
    'school_id' | 'school_name' | 'school_grading_system'
  >,
): T | null {
  const candidates = deadlines.filter(
    (d) => d.is_active && d.requirement_type === requirementType,
  );
  if (candidates.length === 0) return null;

  const schoolSpecific = candidates.find((d) =>
    scholarMatchesDeadlineSchool(scholar, d),
  );
  if (schoolSpecific) return schoolSpecific;

  return candidates.find((d) => d.school_id == null) ?? null;
}

function toIsoTimestamp(value?: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function findMatchingCcgDocument<
  T extends {
    document_id: number;
    document_type?: string | null;
    status: string;
    confirmed_data?: unknown;
    extracted_data?: unknown;
    uploaded_at?: Date | string | null;
    created_at?: Date | string | null;
  },
>(docs: T[], academicYear: string, semester: string): T | undefined {
  const targetAy = normalizeAcademicYear(academicYear);
  const targetSem = normalizeSemester(semester);
  if (!targetAy || !targetSem) return undefined;

  return docs.find((doc) => {
    if ((doc.document_type || '').toUpperCase() !== 'CCG') return false;
    const confirmed =
      doc.confirmed_data && typeof doc.confirmed_data === 'object'
        ? (doc.confirmed_data as Record<string, unknown>)
        : {};
    const extracted =
      doc.extracted_data && typeof doc.extracted_data === 'object'
        ? (doc.extracted_data as Record<string, unknown>)
        : {};
    const docAy =
      (typeof confirmed.academic_year === 'string' &&
        confirmed.academic_year) ||
      (typeof extracted.academic_year === 'string' &&
        extracted.academic_year) ||
      '';
    const docSem =
      (typeof confirmed.semester === 'string' && confirmed.semester) ||
      (typeof extracted.semester === 'string' && extracted.semester) ||
      '';
    if (!docAy || !docSem) return false;

    return (
      normalizeSemester(docSem) === targetSem &&
      academicYearsMatchForTerm(docAy, targetAy, targetSem)
    );
  });
}

function findMatchingGradeReport<
  T extends { academic_year: string; semester: string; status: string },
>(reports: T[], academicYear: string, semester: string): T | undefined {
  const targetAy = normalizeAcademicYear(academicYear);
  const targetSem = normalizeSemester(semester);
  if (!targetAy || !targetSem) return undefined;

  return reports.find(
    (r) =>
      normalizeSemester(r.semester) === targetSem &&
      academicYearsMatchForTerm(r.academic_year, targetAy, targetSem),
  );
}

function scholarNeedsOptionalTermEnrollment(
  scholar: ScholarComplianceInput,
  semester: string,
  existingEnrollment?: {
    status?: string | null;
    cor_document_id?: number | null;
    soa_document_id?: number | null;
  },
): boolean {
  if (
    existingEnrollment &&
    (existingEnrollment.status !== 'DRAFT' ||
      Boolean(existingEnrollment.cor_document_id) ||
      Boolean(existingEnrollment.soa_document_id))
  ) {
    return true;
  }

  const targetSem = normalizeSemester(semester);
  const subjects = scholar.prospectus?.subjects;
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return false;
  }

  const currentYear = scholar.current_year_level ?? null;

  return subjects.some((sub) => {
    if (normalizeSemester(sub.semester) !== targetSem) return false;
    if (sub.status === 'PASSED' || sub.status === 'CREDITED') return false;
    if (currentYear && sub.year_level) {
      return Number(sub.year_level) === Number(currentYear);
    }
    return true;
  });
}

function computeDueState(
  dueDate: Date | string,
  gracePeriodDays: number,
  now: Date,
): {
  isOverdue: boolean;
  isUpcoming: boolean;
  effectiveDueDate: Date;
  daysRemaining: number;
  daysOverdue: number;
} {
  const baseMs = new Date(dueDate).getTime();
  const effectiveDueMs =
    baseMs + Math.max(0, gracePeriodDays || 0) * MS_PER_DAY;
  const nowMs = now.getTime();
  const diffMs = effectiveDueMs - nowMs;

  if (diffMs < 0) {
    const daysOverdue = Math.max(1, Math.ceil(Math.abs(diffMs) / MS_PER_DAY));
    return {
      isOverdue: true,
      isUpcoming: false,
      effectiveDueDate: new Date(effectiveDueMs),
      daysRemaining: 0,
      daysOverdue,
    };
  }

  const daysRemaining = Math.ceil(diffMs / MS_PER_DAY);
  return {
    isOverdue: false,
    isUpcoming: daysRemaining <= 7,
    effectiveDueDate: new Date(effectiveDueMs),
    daysRemaining,
    daysOverdue: 0,
  };
}

export function evaluateScholarRequirementStatus(params: {
  deadline: DeadlineRecordLike;
  scholar: ScholarComplianceInput;
  exemption?: { reason?: string | null } | null;
  now?: Date;
}): EvaluationResult {
  const { deadline, scholar, exemption, now = new Date() } = params;
  const timing = computeDueState(
    deadline.due_date,
    deadline.grace_period_days,
    now,
  );

  if (exemption) {
    return {
      status: 'EXEMPT',
      status_detail: exemption.reason?.trim()
        ? `Exempt: ${exemption.reason.trim()}`
        : 'Marked exempt by coordinator',
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: timing.daysRemaining,
      days_overdue: 0,
    };
  }

  const matchingEnrollment = findMatchingTermEnrollment(
    scholar.enrollments || [],
    deadline.academic_year,
    deadline.semester,
  );

  if (deadline.requirement_type === 'ENROLLMENT') {
    const auditFlagsCount = Array.isArray(matchingEnrollment?.audit_flags)
      ? matchingEnrollment.audit_flags.filter(
          (f) => f && String(f) !== 'ALL_CLEARED',
        ).length
      : 0;
    const buildEnrollmentSubmission = (
      reviewStage: DeadlineSubmissionStage,
    ): DeadlineSubmissionSummary | null => {
      if (!matchingEnrollment) return null;
      return {
        kind: 'ENROLLMENT',
        enrollment_id: matchingEnrollment.enrollment_id,
        raw_status: matchingEnrollment.status,
        review_stage: reviewStage,
        total_assessment:
          matchingEnrollment.total_assessment != null
            ? Number(matchingEnrollment.total_assessment)
            : null,
        total_units:
          matchingEnrollment.total_units != null
            ? Number(matchingEnrollment.total_units)
            : null,
        audit_flags_count: auditFlagsCount,
        submitted_at: toIsoTimestamp(
          matchingEnrollment.updated_at || matchingEnrollment.created_at,
        ),
      };
    };

    if (
      matchingEnrollment &&
      ['PENDING_REVIEW', 'VERIFIED', 'APPROVED', 'COMPLETED'].includes(
        matchingEnrollment.status,
      )
    ) {
      let reviewStage: DeadlineSubmissionStage = 'PENDING_AUDIT';
      let statusDetail = 'Submitted · Awaiting coordinator audit';
      if (matchingEnrollment.status === 'VERIFIED') {
        reviewStage = 'VERIFIED_READY';
        statusDetail = 'Verified · Ready to endorse to Grantor';
      } else if (matchingEnrollment.status === 'APPROVED') {
        reviewStage = 'ENDORSED';
        statusDetail = 'Endorsed to Grantor';
      } else if (matchingEnrollment.status === 'COMPLETED') {
        reviewStage = 'ENDORSED';
        statusDetail = 'Completed & settled';
      }

      return {
        status: 'SUBMITTED',
        status_detail: statusDetail,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
        submission: buildEnrollmentSubmission(reviewStage),
      };
    }

    if (
      matchingEnrollment &&
      ['CHANGES_REQUESTED', 'REJECTED'].includes(matchingEnrollment.status)
    ) {
      const isRejected = matchingEnrollment.status === 'REJECTED';
      return {
        status: 'NEEDS_ACTION',
        status_detail: isRejected
          ? 'Enrollment rejected · Re-upload required'
          : 'Changes requested on enrollment',
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
        submission: buildEnrollmentSubmission(
          isRejected ? 'REJECTED' : 'NEEDS_REVISION',
        ),
      };
    }

    const ongoingEnrollment = (scholar.enrollments || []).find((e) => {
      if (!['APPROVED', 'VERIFIED', 'PENDING_REVIEW'].includes(e.status)) {
        return false;
      }
      const matchingGrade = findMatchingGradeReport(
        scholar.grade_reports || [],
        e.academic_year,
        e.semester,
      );
      return !matchingGrade || matchingGrade.status === 'REJECTED';
    });

    if (ongoingEnrollment) {
      return {
        status: 'CURRENTLY_ENROLLED',
        status_detail:
          ongoingEnrollment.status === 'PENDING_REVIEW'
            ? `Enrollment in review (A.Y. ${ongoingEnrollment.academic_year} ${ongoingEnrollment.semester})`
            : `Currently enrolled (A.Y. ${ongoingEnrollment.academic_year} ${ongoingEnrollment.semester} · awaiting grades)`,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
      };
    }

    if (
      deadline.is_optional_term &&
      !scholarNeedsOptionalTermEnrollment(
        scholar,
        deadline.semester,
        matchingEnrollment,
      )
    ) {
      return {
        status: 'NOT_APPLICABLE',
        status_detail: `Optional ${normalizeSemester(deadline.semester) || deadline.semester} term — not enrolled`,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
      };
    }

    const hasDraft = matchingEnrollment?.status === 'DRAFT';
    if (timing.isOverdue) {
      return {
        status: 'OVERDUE',
        status_detail: hasDraft
          ? `Draft not submitted · Overdue by ${timing.daysOverdue}d`
          : `Overdue by ${timing.daysOverdue}d`,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: timing.daysOverdue,
      };
    }

    return {
      status: timing.isUpcoming ? 'UPCOMING' : 'NOT_SUBMITTED',
      status_detail: hasDraft
        ? `Draft saved · Due in ${timing.daysRemaining}d`
        : `Due in ${timing.daysRemaining}d`,
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: timing.daysRemaining,
      days_overdue: 0,
    };
  }

  // GRADES requirement evaluation
  const matchingReport = findMatchingGradeReport(
    scholar.grade_reports || [],
    deadline.academic_year,
    deadline.semester,
  );
  const matchingCcgDoc = findMatchingCcgDocument(
    scholar.documents || [],
    deadline.academic_year,
    deadline.semester,
  );

  if (matchingReport) {
    if (matchingReport.status === 'REJECTED') {
      return {
        status: 'NEEDS_ACTION',
        status_detail: 'Grade report rejected · Re-upload required',
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
        submission: {
          kind: 'GRADES',
          grade_report_id: matchingReport.report_id,
          grade_document_id:
            matchingReport.document_id ?? matchingCcgDoc?.document_id ?? null,
          raw_status: matchingReport.status,
          review_stage: 'REJECTED',
          submitted_at: toIsoTimestamp(matchingReport.submitted_at),
        },
      };
    }

    return {
      status: 'SUBMITTED',
      status_detail:
        matchingReport.status === 'APPROVED'
          ? 'Submitted & verified'
          : `Submitted (${matchingReport.status})`,
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: 0,
      days_overdue: 0,
      submission: {
        kind: 'GRADES',
        grade_report_id: matchingReport.report_id,
        grade_document_id:
          matchingReport.document_id ?? matchingCcgDoc?.document_id ?? null,
        raw_status: matchingReport.status,
        review_stage: 'ENDORSED',
        submitted_at: toIsoTimestamp(matchingReport.submitted_at),
      },
    };
  }

  if (matchingCcgDoc) {
    if (matchingCcgDoc.status === 'NEEDS_REUPLOAD') {
      return {
        status: 'NEEDS_ACTION',
        status_detail: 'Grade document needs re-upload',
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
        submission: {
          kind: 'GRADES',
          grade_document_id: matchingCcgDoc.document_id,
          raw_status: matchingCcgDoc.status,
          review_stage: 'NEEDS_REVISION',
          submitted_at: toIsoTimestamp(
            matchingCcgDoc.uploaded_at ?? matchingCcgDoc.created_at,
          ),
        },
      };
    }

    if (
      ['PENDING', 'STUDENT_CONFIRMED', 'PASSED_PRECHECK', 'VERIFIED'].includes(
        matchingCcgDoc.status,
      )
    ) {
      const isDocVerified = matchingCcgDoc.status === 'VERIFIED';
      return {
        status: 'SUBMITTED',
        status_detail: isDocVerified
          ? 'Submitted & verified'
          : 'Submitted · Awaiting grade audit',
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
        submission: {
          kind: 'GRADES',
          grade_document_id: matchingCcgDoc.document_id,
          raw_status: matchingCcgDoc.status,
          review_stage: isDocVerified ? 'ENDORSED' : 'PENDING_AUDIT',
          submitted_at: toIsoTimestamp(
            matchingCcgDoc.uploaded_at ?? matchingCcgDoc.created_at,
          ),
        },
      };
    }
  }

  const hasActiveEnrollmentForTerm = Boolean(
    matchingEnrollment &&
    ['PENDING_REVIEW', 'VERIFIED', 'APPROVED', 'COMPLETED'].includes(
      matchingEnrollment.status,
    ),
  );

  if (!hasActiveEnrollmentForTerm) {
    return {
      status: 'NOT_APPLICABLE',
      status_detail: `No submitted ${normalizeSemester(deadline.semester) || deadline.semester} enrollment on record`,
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: 0,
      days_overdue: 0,
    };
  }

  if (timing.isOverdue) {
    return {
      status: 'OVERDUE',
      status_detail: `Grades overdue by ${timing.daysOverdue}d`,
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: 0,
      days_overdue: timing.daysOverdue,
    };
  }

  return {
    status: timing.isUpcoming ? 'UPCOMING' : 'NOT_SUBMITTED',
    status_detail: `Due in ${timing.daysRemaining}d`,
    effective_due_date: timing.effectiveDueDate.toISOString(),
    days_remaining: timing.daysRemaining,
    days_overdue: 0,
  };
}
