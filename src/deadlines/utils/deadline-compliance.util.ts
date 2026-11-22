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
  | 'ON_HOLD'
  | 'NEEDS_ACTION'
  | 'UPCOMING'
  | 'NOT_SUBMITTED'
  | 'OVERDUE'
  | 'EXEMPT'
  | 'NOT_APPLICABLE';

export type DeadlineLockReason =
  | 'APPEAL_REQUIRED'
  | 'APPEAL_PENDING'
  | 'DISCONTINUED'
  | 'ACADEMIC_SHIFT_IN_PROGRESS'
  | 'SHIFT_REQUEST_PENDING';

export interface DeadlineLockInfo {
  reason: DeadlineLockReason;
  label: string;
  detail: string;
}

export const DEFAULT_REVISION_WINDOW_DAYS = 3;

export interface DeadlineRevisionInfo {
  requested_at: string | null;
  days_since_requested: number;
  window_days: number;
  revision_due_date: string | null;
  days_remaining: number;
  days_overdue: number;
  is_stalled: boolean;
  requested_after_deadline: boolean;
}

export type DeadlineReminderMilestone =
  | 'BEFORE_3D'
  | 'DUE_TODAY'
  | 'AFTER_GRACE_1D'
  | 'STALLED_REVISION';

export interface ScheduledReminderMatch {
  milestone: DeadlineReminderMilestone;
  dedup_tag: string;
}

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
  is_late?: boolean;
  days_late?: number;
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
  academic_baseline_status?: string | null;
  archived_at?: Date | string | null;
  archive_reason?: string | null;
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
    coordinator_notes?: string | null;
    reviewed_at?: Date | string | null;
    created_at?: Date | string | null;
    updated_at?: Date | string | null;
    cor_document?: { uploaded_at?: Date | string | null } | null;
    soa_document?: { uploaded_at?: Date | string | null } | null;
  }>;
  grade_reports?: Array<{
    report_id: number;
    document_id?: number | null;
    academic_year: string;
    semester: string;
    status: string;
    appeal_status?: string | null;
    evaluation_flag?: string | null;
    gpa?: unknown;
    reviewed_at?: Date | string | null;
    submitted_at?: Date | string | null;
    document?: { uploaded_at?: Date | string | null } | null;
  }>;
  documents?: Array<{
    document_id: number;
    document_type?: string | null;
    status: string;
    rejection_reason?: string | null;
    confirmed_data?: unknown;
    extracted_data?: unknown;
    uploaded_at?: Date | string | null;
    created_at?: Date | string | null;
    verified_at?: Date | string | null;
  }>;
  academic_change_requests?: Array<{
    request_id: number;
    change_type: string;
    status: string;
    requested_course_of_study?: string | null;
    requested_school_name?: string | null;
    created_at?: Date | string | null;
    reviewed_at?: Date | string | null;
  }>;
}

export interface EvaluationResult {
  status: DeadlineComplianceStatus;
  status_detail: string;
  effective_due_date: string;
  days_remaining: number;
  days_overdue: number;
  is_late?: boolean;
  days_late?: number;
  lock?: DeadlineLockInfo | null;
  revision?: DeadlineRevisionInfo | null;
  submission?: DeadlineSubmissionSummary | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getManilaDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  dateKey: string;
} {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, dateKey };
}

export function diffCalendarDaysManila(
  target: Date | string,
  reference: Date,
): number {
  const targetDate = target instanceof Date ? target : new Date(target);
  const t = getManilaDateParts(targetDate);
  const r = getManilaDateParts(reference);
  const targetDayMs = Date.UTC(t.year, t.month - 1, t.day);
  const refDayMs = Date.UTC(r.year, r.month - 1, r.day);
  return Math.round((targetDayMs - refDayMs) / MS_PER_DAY);
}

export function computeRevisionState(
  requestedAt: Date | string | null | undefined,
  effectiveDueDate: Date,
  now: Date,
  windowDays = DEFAULT_REVISION_WINDOW_DAYS,
): DeadlineRevisionInfo | null {
  const requestedDate = parseValidDate(requestedAt);
  if (!requestedDate) return null;

  const requested_after_deadline =
    requestedDate.getTime() > effectiveDueDate.getTime();
  const elapsedMs = Math.max(0, now.getTime() - requestedDate.getTime());
  const days_since_requested = Math.floor(elapsedMs / MS_PER_DAY);
  const revisionDueDate = new Date(
    requestedDate.getTime() + windowDays * MS_PER_DAY,
  );
  const diffMs = revisionDueDate.getTime() - now.getTime();

  if (diffMs < 0) {
    return {
      requested_at: requestedDate.toISOString(),
      days_since_requested,
      window_days: windowDays,
      revision_due_date: revisionDueDate.toISOString(),
      days_remaining: 0,
      days_overdue: Math.max(1, Math.ceil(Math.abs(diffMs) / MS_PER_DAY)),
      is_stalled: true,
      requested_after_deadline,
    };
  }

  return {
    requested_at: requestedDate.toISOString(),
    days_since_requested,
    window_days: windowDays,
    revision_due_date: revisionDueDate.toISOString(),
    days_remaining: Math.ceil(diffMs / MS_PER_DAY),
    days_overdue: 0,
    is_stalled: false,
    requested_after_deadline,
  };
}

function formatRevisionStatusDetail(
  prefix: string,
  fallback: string,
  revision: DeadlineRevisionInfo | null,
): string {
  if (!revision) return fallback;
  const whenLabel =
    revision.days_since_requested === 0
      ? 'today'
      : `${revision.days_since_requested}d ago`;
  if (revision.is_stalled) {
    return `${prefix} ${whenLabel} · Revision window expired ${revision.days_overdue}d ago`;
  }
  return `${prefix} ${whenLabel} · ${revision.days_remaining}d left in ${revision.window_days}d revision window`;
}

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

function parseValidDate(value?: Date | string | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoTimestamp(value?: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function latestValidDate(values: Array<Date | string | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const val of values) {
    const parsed = parseValidDate(val);
    if (!parsed) continue;
    if (!latest || parsed.getTime() > latest.getTime()) {
      latest = parsed;
    }
  }
  return latest;
}

function resolveEnrollmentSubmittedAt(enrollment: {
  status: string;
  reviewed_at?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  cor_document?: { uploaded_at?: Date | string | null } | null;
  soa_document?: { uploaded_at?: Date | string | null } | null;
}): Date | null {
  const docUploads = [
    parseValidDate(enrollment.cor_document?.uploaded_at),
    parseValidDate(enrollment.soa_document?.uploaded_at),
  ].filter((d): d is Date => d !== null);
  const reviewedAt = parseValidDate(enrollment.reviewed_at);

  if (enrollment.status === 'PENDING_REVIEW' && !reviewedAt) {
    return latestValidDate([
      enrollment.updated_at,
      enrollment.created_at,
      ...docUploads,
    ]);
  }

  if (docUploads.length > 0) {
    const candidate = latestValidDate([...docUploads, enrollment.created_at]);
    if (candidate && reviewedAt && candidate.getTime() > reviewedAt.getTime()) {
      return reviewedAt;
    }
    return candidate;
  }

  return parseValidDate(enrollment.created_at) ?? parseValidDate(enrollment.updated_at);
}

function resolveGradeReportSubmittedAt(
  report: {
    document_id?: number | null;
    submitted_at?: Date | string | null;
    document?: { uploaded_at?: Date | string | null } | null;
  },
  matchingCcgDoc?: {
    document_id: number;
    uploaded_at?: Date | string | null;
    created_at?: Date | string | null;
  },
): Date | null {
  const reportDocUpload = parseValidDate(report.document?.uploaded_at);
  if (reportDocUpload) return reportDocUpload;

  if (
    matchingCcgDoc &&
    (!report.document_id || matchingCcgDoc.document_id === report.document_id)
  ) {
    const ccgUpload = parseValidDate(
      matchingCcgDoc.uploaded_at ?? matchingCcgDoc.created_at,
    );
    if (ccgUpload) return ccgUpload;
  }

  return parseValidDate(report.submitted_at);
}

export function computeSubmissionLateness(
  submittedAt: Date | string | null | undefined,
  effectiveDueDate: Date,
): { is_late: boolean; days_late: number } {
  const submittedDate = parseValidDate(submittedAt);
  if (!submittedDate) {
    return { is_late: false, days_late: 0 };
  }
  const diffMs = submittedDate.getTime() - effectiveDueDate.getTime();
  if (diffMs <= 0) {
    return { is_late: false, days_late: 0 };
  }
  return {
    is_late: true,
    days_late: Math.max(1, Math.ceil(diffMs / MS_PER_DAY)),
  };
}

export function detectScholarDeadlineLock(
  scholar: ScholarComplianceInput,
  requirementType: string,
): DeadlineLockInfo | null {
  const sortedReports = [...(scholar.grade_reports || [])].sort((a, b) => {
    const aMs = parseValidDate(a.submitted_at)?.getTime() ?? 0;
    const bMs = parseValidDate(b.submitted_at)?.getTime() ?? 0;
    return bMs - aMs;
  });

  const latestFlagged = sortedReports.find(
    (r) => r.status === 'FLAGGED' && r.appeal_status !== 'APPROVED',
  );

  const hasPriorResolvedAppeal = Boolean(
    latestFlagged &&
      (!latestFlagged.appeal_status || latestFlagged.appeal_status === 'NONE') &&
      sortedReports.some(
        (r) =>
          r.report_id !== latestFlagged.report_id &&
          ['APPROVED', 'DENIED'].includes(r.appeal_status || ''),
      ),
  );

  if (
    scholar.academic_baseline_status === 'DISCONTINUED' ||
    Boolean(scholar.archived_at) ||
    latestFlagged?.appeal_status === 'DENIED' ||
    hasPriorResolvedAppeal
  ) {
    return {
      reason: 'DISCONTINUED',
      label: 'Scholarship Discontinued',
      detail:
        'On Hold — Scholarship discontinued following academic standing / appeal decision',
    };
  }

  if (requirementType !== 'ENROLLMENT') {
    return null;
  }

  const changeRequests = scholar.academic_change_requests || [];
  const isShiftInProgress =
    scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS' ||
    (scholar.academic_baseline_status === 'PENDING_COORDINATOR_REVIEW' &&
      !scholar.prospectus?.is_frozen &&
      changeRequests.some((r) => r.status === 'APPROVED'));

  if (isShiftInProgress) {
    return {
      reason: 'ACADEMIC_SHIFT_IN_PROGRESS',
      label: 'Shift Prospectus Pending',
      detail:
        'On Hold — Program shift / school transfer prospectus pending upload & verification',
    };
  }

  const pendingShift = changeRequests.find((r) => r.status === 'PENDING_GRANTOR');
  if (pendingShift) {
    const changeLabel =
      pendingShift.change_type === 'SCHOOL_TRANSFER'
        ? 'School transfer'
        : pendingShift.change_type === 'BOTH'
          ? 'Program shift & school transfer'
          : 'Program shift';
    return {
      reason: 'SHIFT_REQUEST_PENDING',
      label: `${changeLabel} Pending`,
      detail: `On Hold — ${changeLabel} request awaiting Grantor approval`,
    };
  }

  if (latestFlagged) {
    if (latestFlagged.appeal_status === 'PENDING_GRANTOR') {
      return {
        reason: 'APPEAL_PENDING',
        label: 'Appeal Pending',
        detail: `On Hold — Second Chance Appeal awaiting Grantor verdict (${latestFlagged.academic_year} ${latestFlagged.semester})`,
      };
    }
    return {
      reason: 'APPEAL_REQUIRED',
      label: 'Appeal Required',
      detail: `On Hold — Flagged academic standing (${latestFlagged.academic_year} ${latestFlagged.semester}); Second Chance Appeal required`,
    };
  }

  return null;
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
    const submittedDate = matchingEnrollment
      ? resolveEnrollmentSubmittedAt(matchingEnrollment)
      : null;
    const buildEnrollmentSubmission = (
      reviewStage: DeadlineSubmissionStage,
      lateness?: { is_late: boolean; days_late: number },
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
        submitted_at: toIsoTimestamp(submittedDate),
        ...(lateness ? { is_late: lateness.is_late, days_late: lateness.days_late } : {}),
      };
    };

    if (
      matchingEnrollment &&
      ['PENDING_REVIEW', 'VERIFIED', 'APPROVED', 'COMPLETED'].includes(
        matchingEnrollment.status,
      )
    ) {
      const lateness = computeSubmissionLateness(
        submittedDate,
        timing.effectiveDueDate,
      );
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
      if (lateness.is_late) {
        statusDetail += ` · Late by ${lateness.days_late}d`;
      }

      return {
        status: 'SUBMITTED',
        status_detail: statusDetail,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
        is_late: lateness.is_late,
        days_late: lateness.days_late,
        submission: buildEnrollmentSubmission(reviewStage, lateness),
      };
    }

    if (
      matchingEnrollment &&
      ['CHANGES_REQUESTED', 'REJECTED'].includes(matchingEnrollment.status)
    ) {
      const isRejected = matchingEnrollment.status === 'REJECTED';
      const revision = computeRevisionState(
        matchingEnrollment.reviewed_at ?? matchingEnrollment.updated_at,
        timing.effectiveDueDate,
        now,
      );
      const prefix = isRejected ? 'Enrollment rejected' : 'Changes requested';
      const fallback = isRejected
        ? 'Enrollment rejected · Re-upload required'
        : 'Changes requested on enrollment';
      return {
        status: 'NEEDS_ACTION',
        status_detail: formatRevisionStatusDetail(prefix, fallback, revision),
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
        revision,
        submission: buildEnrollmentSubmission(
          isRejected ? 'REJECTED' : 'NEEDS_REVISION',
        ),
      };
    }

    const lock = detectScholarDeadlineLock(scholar, 'ENROLLMENT');
    if (lock?.reason === 'DISCONTINUED') {
      return {
        status: 'ON_HOLD',
        status_detail: lock.detail,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
        lock,
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

    if (lock) {
      return {
        status: 'ON_HOLD',
        status_detail: lock.detail,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
        lock,
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
      const revision = computeRevisionState(
        matchingReport.reviewed_at ?? matchingReport.submitted_at,
        timing.effectiveDueDate,
        now,
      );
      return {
        status: 'NEEDS_ACTION',
        status_detail: formatRevisionStatusDetail(
          'Grade report rejected',
          'Grade report rejected · Re-upload required',
          revision,
        ),
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
        revision,
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

    const submittedDate = resolveGradeReportSubmittedAt(
      matchingReport,
      matchingCcgDoc,
    );
    const lateness = computeSubmissionLateness(
      submittedDate,
      timing.effectiveDueDate,
    );
    let statusDetail =
      matchingReport.status === 'APPROVED'
        ? 'Submitted & verified'
        : `Submitted (${matchingReport.status})`;
    if (lateness.is_late) {
      statusDetail += ` · Late by ${lateness.days_late}d`;
    }

    return {
      status: 'SUBMITTED',
      status_detail: statusDetail,
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: 0,
      days_overdue: 0,
      is_late: lateness.is_late,
      days_late: lateness.days_late,
      submission: {
        kind: 'GRADES',
        grade_report_id: matchingReport.report_id,
        grade_document_id:
          matchingReport.document_id ?? matchingCcgDoc?.document_id ?? null,
        raw_status: matchingReport.status,
        review_stage: 'ENDORSED',
        submitted_at: toIsoTimestamp(submittedDate),
        is_late: lateness.is_late,
        days_late: lateness.days_late,
      },
    };
  }

  if (matchingCcgDoc) {
    if (matchingCcgDoc.status === 'NEEDS_REUPLOAD') {
      const revision = computeRevisionState(
        matchingCcgDoc.uploaded_at ?? matchingCcgDoc.created_at,
        timing.effectiveDueDate,
        now,
      );
      return {
        status: 'NEEDS_ACTION',
        status_detail: formatRevisionStatusDetail(
          'Grade document needs re-upload',
          'Grade document needs re-upload',
          revision,
        ),
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: timing.daysRemaining,
        days_overdue: timing.daysOverdue,
        revision,
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
      const submittedDate = parseValidDate(
        matchingCcgDoc.uploaded_at ?? matchingCcgDoc.created_at,
      );
      const lateness = computeSubmissionLateness(
        submittedDate,
        timing.effectiveDueDate,
      );
      let statusDetail = isDocVerified
        ? 'Submitted & verified'
        : 'Submitted · Awaiting grade audit';
      if (lateness.is_late) {
        statusDetail += ` · Late by ${lateness.days_late}d`;
      }

      return {
        status: 'SUBMITTED',
        status_detail: statusDetail,
        effective_due_date: timing.effectiveDueDate.toISOString(),
        days_remaining: 0,
        days_overdue: 0,
        is_late: lateness.is_late,
        days_late: lateness.days_late,
        submission: {
          kind: 'GRADES',
          grade_document_id: matchingCcgDoc.document_id,
          raw_status: matchingCcgDoc.status,
          review_stage: isDocVerified ? 'ENDORSED' : 'PENDING_AUDIT',
          submitted_at: toIsoTimestamp(submittedDate),
          is_late: lateness.is_late,
          days_late: lateness.days_late,
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

  const gradeLock = detectScholarDeadlineLock(scholar, 'GRADES');
  if (gradeLock) {
    return {
      status: 'ON_HOLD',
      status_detail: gradeLock.detail,
      effective_due_date: timing.effectiveDueDate.toISOString(),
      days_remaining: 0,
      days_overdue: 0,
      lock: gradeLock,
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

export function resolveScheduledReminderMilestone(params: {
  deadline: DeadlineRecordLike;
  evaluation: EvaluationResult;
  now?: Date;
}): ScheduledReminderMatch | null {
  const { deadline, evaluation, now = new Date() } = params;
  if (
    !['OVERDUE', 'NEEDS_ACTION', 'UPCOMING', 'NOT_SUBMITTED'].includes(
      evaluation.status,
    )
  ) {
    return null;
  }

  if (evaluation.status === 'NEEDS_ACTION' && evaluation.revision?.is_stalled) {
    const reqDay = evaluation.revision.requested_at
      ? evaluation.revision.requested_at.slice(0, 10)
      : 'default';
    return {
      milestone: 'STALLED_REVISION',
      dedup_tag: `AUTO:STALLED_REVISION:${reqDay}`,
    };
  }

  const daysToCutoff = diffCalendarDaysManila(
    evaluation.effective_due_date,
    now,
  );
  if (
    daysToCutoff === -1 &&
    (evaluation.status === 'OVERDUE' || evaluation.status === 'NEEDS_ACTION')
  ) {
    return {
      milestone: 'AFTER_GRACE_1D',
      dedup_tag: 'AUTO:AFTER_GRACE_1D',
    };
  }

  const daysToDue = diffCalendarDaysManila(deadline.due_date, now);
  if (daysToDue === 0) {
    return {
      milestone: 'DUE_TODAY',
      dedup_tag: 'AUTO:DUE_TODAY',
    };
  }
  if (daysToDue === 3) {
    return {
      milestone: 'BEFORE_3D',
      dedup_tag: 'AUTO:BEFORE_3D',
    };
  }

  return null;
}
