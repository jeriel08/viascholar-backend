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
  }>;
  grade_reports?: Array<{
    report_id: number;
    academic_year: string;
    semester: string;
    status: string;
    submitted_at?: Date | string | null;
  }>;
}

export interface EvaluationResult {
  status: DeadlineComplianceStatus;
  status_detail: string;
  effective_due_date: string;
  days_remaining: number;
  days_overdue: number;
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

function findMatchingGradeReport<
  T extends { academic_year: string; semester: string; status: string },
>(
  reports: T[],
  academicYear: string,
  semester: string,
): T | undefined {
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
  const effectiveDueMs = baseMs + Math.max(0, gracePeriodDays || 0) * MS_PER_DAY;
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
    if (
      matchingEnrollment &&
      ['PENDING_REVIEW', 'APPROVED', 'COMPLETED'].includes(
        matchingEnrollment.status,
      )
    ) {
      return {
        status: 'SUBMITTED',
        status_detail:
          matchingEnrollment.status === 'PENDING_REVIEW'
            ? 'Submitted · Awaiting coordinator audit'
            : `Submitted (${matchingEnrollment.status})`,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
      };
    }

    if (
      matchingEnrollment &&
      ['CHANGES_REQUESTED', 'REJECTED'].includes(matchingEnrollment.status)
    ) {
      return {
        status: 'NEEDS_ACTION',
        status_detail:
          matchingEnrollment.status === 'CHANGES_REQUESTED'
            ? 'Changes requested on enrollment'
            : 'Enrollment rejected · Re-upload required',
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
      };
    }

    const ongoingEnrollment = (scholar.enrollments || []).find((e) => {
      if (!['APPROVED', 'PENDING_REVIEW'].includes(e.status)) return false;
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

  if (matchingReport) {
    if (matchingReport.status === 'REJECTED') {
      return {
        status: 'NEEDS_ACTION',
        status_detail: 'Grade report rejected · Re-upload required',
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
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
    };
  }

  const hasActiveEnrollmentForTerm = Boolean(
    matchingEnrollment &&
      ['PENDING_REVIEW', 'APPROVED', 'COMPLETED'].includes(
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
