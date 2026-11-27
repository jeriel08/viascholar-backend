import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { Role } from '../generated/prisma/enums.js';
import { AnalyticsQueryDto, ExplainChartDto } from './dto/analytics.dto.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { evaluateProspectusGraduation } from '../common/utils/graduation-readiness.util.js';
import {
  academicYearsMatchForTerm,
  normalizeAcademicYear,
  normalizeSemester,
} from '../documents/utils/academic-term.util.js';

export interface DescriptiveStats {
  count: number;
  mean: number;
  standardDeviation: number;
  variance: number;
  min: number;
  max: number;
  median: number;
  q1: number;
  q3: number;
  complianceRate: number;
  goodStandingCount: number;
  probationCount: number;
  flaggedCount: number;
}

export interface FinancialAspectData {
  disbursedCount: number;
  disbursedPercent: number;
  undisbursedCount: number;
  undisbursedPercent: number;
  totalSemesterAssessment: number;
  totalDisbursedAmount: number;
  totalPendingAmount: number;
  totalScholarsCount: number;
}

export interface YearLevelBreakdownItem {
  yearLevel: number;
  label: string;
  count: number;
  pct: number;
}

const YEAR_LEVEL_BUCKETS: ReadonlyArray<{ yearLevel: number; label: string }> = [
  { yearLevel: 1, label: '1st Year' },
  { yearLevel: 2, label: '2nd Year' },
  { yearLevel: 3, label: '3rd Year' },
  { yearLevel: 4, label: '4th Year' },
  { yearLevel: 5, label: '5th Year' },
  { yearLevel: 6, label: '6th Year' },
];

export interface AcademicStandingBreakdown {
  goodStandingCount: number;
  goodStandingPercent: number;
  probationCount: number;
  probationPercent: number;
  flaggedCount: number;
  flaggedPercent: number;
  complianceRate: number;
}

export interface AcademicAspectData {
  unsubmittedGradesCount: number;
  unsubmittedGradesPercent: number;
  submittedGradesCount: number;
  submittedGradesPercent: number;
  notEnrolledCount: number;
  notEnrolledPercent: number;
  enrolledCount: number;
  enrolledPercent: number;
  graduatingCount: number;
  graduatingPercent: number;
  graduatedCount: number;
  graduatedPercent: number;
  undergradCount: number;
  undergradPercent: number;
  totalScholarsCount: number;
  standingBreakdown: AcademicStandingBreakdown;
  yearLevelBreakdown: YearLevelBreakdownItem[];
}

export interface DescriptiveNarratives {
  financialSummary: string;
  academicSummary: string;
}

export interface ScholarOperationalItem {
  id: number;
  userId: number;
  name: string;
  email: string;
  school: string;
  course: string;
  track: string;
  yearLevel: number;
  isGraduating: boolean;
  isGraduatedInTerm: boolean;
  enrollmentStatus: 'ENROLLED' | 'NOT_ENROLLED';
  gradeStatus: 'SUBMITTED' | 'UNSUBMITTED';
  gwa: number;
  standing: 'GOOD' | 'PROBATION' | 'AT_RISK';
  disbursementStatus: 'DISBURSED' | 'PENDING' | 'NOT_APPLIED';
  assessmentAmount: number;
  disbursedAmount: number;
  isArchived?: boolean;
  archiveReason?: string | null;
}

export interface AnalyticsFilterOptions {
  availableSemesters: string[];
  availableAcademicYears: string[];
  termsByYear?: Record<string, string[]>;
  selectedSemester: string;
  selectedAcademicYear: string;
  isHistoricalTerm: boolean;
  graduationClassYear: number | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
    private readonly cacheService: AppCacheService,
  ) {}

  /**
   * Calculates descriptive statistics (Mean, Std Dev, Quartiles, Compliance Rate)
   * for a numeric array of scholar GWAs and eligibility flags.
   */
  private computeDescriptiveStats(
    scholars: Array<{
      gwa: number;
      normalizedScore: number;
      health: 'good' | 'warn' | 'bad';
      isCompliant: boolean;
    }>,
  ): DescriptiveStats {
    const count = scholars.length;
    if (count === 0) {
      return {
        count: 0,
        mean: 0,
        standardDeviation: 0,
        variance: 0,
        min: 0,
        max: 0,
        median: 0,
        q1: 0,
        q3: 0,
        complianceRate: 0,
        goodStandingCount: 0,
        probationCount: 0,
        flaggedCount: 0,
      };
    }

    const gwas = scholars.map((s) => s.gwa);
    const sum = gwas.reduce((acc, val) => acc + val, 0);
    const mean = Number((sum / count).toFixed(2));

    const sumSqDiff = gwas.reduce(
      (acc, val) => acc + Math.pow(val - mean, 2),
      0,
    );
    const variance = Number((sumSqDiff / count).toFixed(4));
    const standardDeviation = Number(Math.sqrt(variance).toFixed(2));

    const sorted = [...gwas].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    const getPercentile = (arr: number[], p: number): number => {
      const idx = (arr.length - 1) * p;
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      const weight = idx - lower;
      if (lower === upper) return arr[lower];
      return Number(
        (arr[lower] * (1 - weight) + arr[upper] * weight).toFixed(2),
      );
    };

    const q1 = getPercentile(sorted, 0.25);
    const median = getPercentile(sorted, 0.5);
    const q3 = getPercentile(sorted, 0.75);

    const goodStandingCount = scholars.filter((s) => s.health === 'good').length;
    const probationCount = scholars.filter((s) => s.health === 'warn').length;
    const flaggedCount = scholars.filter((s) => s.health === 'bad').length;

    const compliantCount = scholars.filter((s) => s.isCompliant).length;
    const complianceRate = Number(((compliantCount / count) * 100).toFixed(1));

    return {
      count,
      mean,
      standardDeviation,
      variance,
      min,
      max,
      median,
      q1,
      q3,
      complianceRate,
      goodStandingCount,
      probationCount,
      flaggedCount,
    };
  }

  /**
   * Application-phase High School Form 9 / Form 138 / SF9 reports
   * belong to the applicant onboarding stage and must be excluded from
   * collegiate scholar analytics.
   */
  private isForm9OrApplicationGrade(report: {
    semester?: string | null;
    document?: {
      document_type?: string | null;
      label?: string | null;
    } | null;
  }): boolean {
  const sem = (report.semester || '').trim().toLowerCase();
  if (sem === 'annual' || sem.includes('annual')) {
    return true;
  }

  const docType = (report.document?.document_type || '').toLowerCase();
  const label = (report.document?.label || '').toLowerCase();

  const isForm9OrHsPattern =
    /form\s*9|138|137|sf9|senior\s*high|high\s*school|report\s*card/i;

  return (
    isForm9OrHsPattern.test(docType) ||
    isForm9OrHsPattern.test(label)
  );
}

  private isUnverifiedDocStatus(status?: string | null): boolean {
    if (!status) return false;
    return [
      'PENDING',
      'PASSED_PRECHECK',
      'NEEDS_REUPLOAD',
      'REJECTED',
    ].includes(status.toUpperCase());
  }

  /**
   * Analytics must strictly ignore scholar drafts, rejected/unsubmitted
   * enrollments, or enrollments backed only by unverified (e.g. PASSED_PRECHECK)
   * assessment/COR documents.
   */
  private isOfficialEnrollmentForAnalytics(enrollment: {
    status?: string | null;
    cor_document?: { status?: string | null } | null;
    soa_document?: { status?: string | null } | null;
  }): boolean {
    const status = (enrollment.status || '').toUpperCase().trim();
    if (
      ['DRAFT', 'REJECTED', 'CHANGES_REQUESTED', 'PENDING_REVIEW'].includes(
        status,
      )
    ) {
      return false;
    }

    if (
      enrollment.soa_document?.status &&
      this.isUnverifiedDocStatus(enrollment.soa_document.status) &&
      !['APPROVED', 'COMPLETED'].includes(status)
    ) {
      return false;
    }

    if (
      enrollment.cor_document?.status &&
      this.isUnverifiedDocStatus(enrollment.cor_document.status) &&
      !['APPROVED', 'COMPLETED'].includes(status)
    ) {
      return false;
    }

    return true;
  }

  private isAssessmentVerifiedForAnalytics(enrollment: {
    status?: string | null;
    soa_document?: { status?: string | null } | null;
  }): boolean {
    if (!this.isOfficialEnrollmentForAnalytics(enrollment)) {
      return false;
    }
    if (
      enrollment.soa_document?.status &&
      this.isUnverifiedDocStatus(enrollment.soa_document.status)
    ) {
      return false;
    }
    return true;
  }

  /**
   * Main descriptive analytics endpoint for Grantor & Coordinator dashboards.
   * Computes Financial Aspect (Disbursed vs Undisbursed %, Semester Imbursement Summary)
   * and Academic Aspect (Unsubmitted Grades %, Not Enrolled %, Graduating %, Standing, Year-Level Distribution)
   * with real-time descriptive narrative summaries and zero trend forecasting.
   */
  async getDescriptiveAnalytics(query: AnalyticsQueryDto, forceRefresh = false) {
    const cacheKey = `analytics:financial_academic_v4:${query.schoolId || 'all'}:${query.track || 'all'}:${query.course || 'all'}:${query.academicYear || 'all'}:${query.semester || 'all'}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const [
          systemSetting,
          scholarProfiles,
          allEnrollments,
          allDisbursements,
        ] = await Promise.all([
          this.prisma.systemSetting.findFirst(),
          this.prisma.scholarProfile.findMany({
            where: {
              user: { role: Role.SCHOLAR },
              ...(query.schoolId ? { school_id: query.schoolId } : {}),
              ...(query.track ? { scholarship_track: query.track } : {}),
              ...(query.course ? { course_of_study: query.course } : {}),
            },
            include: {
              user: { select: { user_id: true, email: true } },
              school_grading_system: true,
              school: true,
              grade_reports: {
                include: {
                  document: {
                    select: {
                      document_type: true,
                      label: true,
                      status: true,
                    },
                  },
                },
                orderBy: { submitted_at: 'desc' },
              },
              enrollments: {
                include: {
                  cor_document: { select: { status: true } },
                  soa_document: { select: { status: true } },
                },
                orderBy: { created_at: 'desc' },
              },
              disbursements: {
                orderBy: { disbursement_id: 'desc' },
              },
              prospectus: {
                include: {
                  subjects: {
                    select: {
                      units: true,
                      grade: true,
                      status: true,
                      year_level: true,
                    },
                  },
                },
              },
            },
            orderBy: { profile_id: 'desc' },
          }),
          this.prisma.termEnrollment.findMany({
            where: {
              status: {
                notIn: [
                  'DRAFT',
                  'REJECTED',
                  'CHANGES_REQUESTED',
                  'PENDING_REVIEW',
                ],
              },
            },
            select: {
              academic_year: true,
              semester: true,
              total_assessment: true,
              status: true,
              cor_document: { select: { status: true } },
              soa_document: { select: { status: true } },
            },
          }),
          this.prisma.disbursement.findMany({
            select: {
              academic_year: true,
              semester: true,
              amount: true,
              status: true,
            },
          }),
        ]);

        const gradeThreshold = systemSetting?.grade_threshold
          ? Number(systemSetting.grade_threshold)
          : 90.0;

        // 1. Determine available distinct Semesters, Trimesters & School Years STRICTLY from actual term records in DB
        const foundSemesters = new Set<string>();
        const foundYears = new Set<string>();
        const termsByYear: Record<string, Set<string>> = {};

        const registerTerm = (ay?: string | null, sem?: string | null) => {
          const cleanAy = ay?.trim();
          const cleanSem = sem?.trim();
          if (!cleanAy || !cleanSem) return;

          // An academic year is ONLY valid if it has a legitimate semester/trimester (not Annual and not ALL)
          const lowerSem = cleanSem.toLowerCase();
          const isValidSem = lowerSem !== 'all' && !lowerSem.includes('annual');

          if (isValidSem) {
            const canonicalAy = normalizeAcademicYear(cleanAy) || cleanAy;
            const canonicalSem = normalizeSemester(cleanSem) || cleanSem;

            foundYears.add(canonicalAy);
            if (!termsByYear[canonicalAy]) {
              termsByYear[canonicalAy] = new Set<string>();
            }
            termsByYear[canonicalAy].add(canonicalSem);
            foundSemesters.add(canonicalSem);
          }
        };

        for (const e of allEnrollments) {
          if (this.isOfficialEnrollmentForAnalytics(e)) {
            registerTerm(e.academic_year, e.semester);
          }
        }
        for (const d of allDisbursements) {
          registerTerm(d.academic_year, d.semester);
        }

        // Collapse standalone single-year Summer entries (e.g. "2024" -> Summer)
        // into their parent academic year (e.g. "2023-2024") when that parent SY exists.
        for (const y of Array.from(foundYears)) {
          if (/^\d{4}$/.test(y)) {
            const parentAy = `${Number(y) - 1}-${y}`;
            const semsForSingleYear = termsByYear[y];
            if (
              foundYears.has(parentAy) &&
              semsForSingleYear &&
              Array.from(semsForSingleYear).every(
                (s) => normalizeSemester(s) === 'Summer',
              )
            ) {
              for (const s of semsForSingleYear) {
                termsByYear[parentAy].add(s);
              }
              foundYears.delete(y);
              delete termsByYear[y];
            }
          }
        }
        // Grade reports intentionally do NOT register term filters on their own.
        // A CCG/grade report can carry a stale or mismatched school year (e.g.
        // an SY 2024-25 CCG submitted against an SY 2023-24 enrollment), which
        // would otherwise introduce a phantom term into the analytics filters.
        // Valid terms come from enrollments and disbursements only.

        // Natural sort order for Semesters, Trimesters, and Summer terms
        const SEMESTER_ORDER: Record<string, number> = {
          '1st semester': 1,
          '1st trimester': 1,
          '1st term': 1,
          '2nd semester': 2,
          '2nd trimester': 2,
          '2nd term': 2,
          '3rd semester': 3,
          '3rd trimester': 3,
          '3rd term': 3,
          'summer': 4,
          'summer term': 4,
          'midyear': 4,
        };

        const sortSemesters = (list: string[]) =>
          [...list].sort((a, b) => {
            const orderA = SEMESTER_ORDER[a.toLowerCase()] ?? 99;
            const orderB = SEMESTER_ORDER[b.toLowerCase()] ?? 99;
            if (orderA !== orderB) return orderA - orderB;
            return a.localeCompare(b);
          });

        // Graceful fallback ONLY if the database currently has 0 recorded terms
        if (foundYears.size === 0) {
          const curr = new Date().getFullYear();
          foundYears.add(`${curr}-${curr + 1}`);
        }
        if (foundSemesters.size === 0) {
          foundSemesters.add('1st Semester');
        }

        const availableAcademicYears = Array.from(foundYears).sort().reverse();
        const availableSemesters = sortSemesters(Array.from(foundSemesters));

        const formattedTermsByYear: Record<string, string[]> = {};
        for (const [y, sSet] of Object.entries(termsByYear)) {
          formattedTermsByYear[y] = sortSemesters(Array.from(sSet));
        }

        // Helper to normalize academic year strings (e.g. "2023-24" vs "2023-2024")
        const normalizeAy = (ayStr?: string | null) =>
          normalizeAcademicYear(ayStr) || (ayStr || '').trim().toLowerCase();

        // 2. Resolve Active / Filtered Term
        const rawQueryAy = query.academicYear?.trim();
        const rawQuerySem = query.semester?.trim();
        const normQueryAy = normalizeAy(rawQueryAy);
        const isSummerQuery =
          normalizeSemester(rawQuerySem || 'Summer') === 'Summer';

        const matchedAvailableYear =
          rawQueryAy && rawQueryAy !== 'ALL'
            ? availableAcademicYears.find(
                (y) => normalizeAy(y) === normQueryAy,
              ) ||
              (isSummerQuery && /^\d{4}$/.test(normQueryAy)
                ? availableAcademicYears.find(
                    (y) =>
                      normalizeAy(y) ===
                      `${Number(normQueryAy) - 1}-${normQueryAy}`,
                  )
                : undefined) ||
              availableAcademicYears.find((y) =>
                academicYearsMatchForTerm(
                  y,
                  rawQueryAy,
                  rawQuerySem || 'Summer',
                ),
              )
            : undefined;

        const selectedAcademicYear =
          rawQueryAy === 'ALL'
            ? 'ALL'
            : matchedAvailableYear || availableAcademicYears[0];

        // Semesters valid for the selected academic year
        const yearSemesters =
          selectedAcademicYear !== 'ALL' &&
          formattedTermsByYear[selectedAcademicYear]?.length > 0
            ? formattedTermsByYear[selectedAcademicYear]
            : availableSemesters;

        const normalizedQuerySem = (
          normalizeSemester(rawQuerySem) ||
          rawQuerySem ||
          ''
        ).toLowerCase();
        const matchedYearSemester = rawQuerySem
          ? yearSemesters.find(
              (s) =>
                (normalizeSemester(s) || s.trim()).toLowerCase() ===
                normalizedQuerySem,
            )
          : undefined;
        const selectedSemester =
          matchedYearSemester ||
          yearSemesters[0] ||
          availableSemesters[0] ||
          '1st Semester';

        const isMatchTerm = (ay?: string | null, sem?: string | null) => {
          const normAy = normalizeAy(ay);
          const normSelectedAy = normalizeAy(selectedAcademicYear);
          const matchAy =
            selectedAcademicYear === 'ALL' ||
            !normAy ||
            normAy === normSelectedAy ||
            academicYearsMatchForTerm(
              ay,
              selectedAcademicYear,
              sem || selectedSemester,
            );
          const normSem = (normalizeSemester(sem) || (sem || '').trim()).toLowerCase();
          const normSelectedSem = (
            normalizeSemester(selectedSemester) || selectedSemester.trim()
          ).toLowerCase();
          const matchSem = !sem || normSem === normSelectedSem;
          return matchAy && matchSem;
        };

        // 3. Process each scholar's Financial & Academic Status for the selected term
        const operationalScholars: ScholarOperationalItem[] = [];
        const processedLegacyScholars: Array<{
          gwa: number;
          normalizedScore: number;
          health: 'good' | 'warn' | 'bad';
          isCompliant: boolean;
        }> = [];

        let totalSemesterAssessment = 0;
        let totalDisbursedAmount = 0;
        let totalPendingAmount = 0;

        const latestAcademicYear = availableAcademicYears[0];
        const parseAyBounds = (
          ay?: string | null,
        ): { start: number; end: number } | null => {
          const norm = normalizeAy(ay);
          if (!norm || norm === 'all') return null;
          const spanMatch = norm.match(/^(\d{4})\s*-\s*(\d{4})$/);
          if (spanMatch) {
            return {
              start: Number(spanMatch[1]),
              end: Number(spanMatch[2]),
            };
          }
          const singleMatch = norm.match(/(\d{4})/);
          if (singleMatch) {
            const yr = Number(singleMatch[1]);
            return { start: yr, end: yr };
          }
          return null;
        };

        const selectedAyBounds =
          selectedAcademicYear !== 'ALL'
            ? parseAyBounds(selectedAcademicYear)
            : null;
        const latestAyBounds = latestAcademicYear
          ? parseAyBounds(latestAcademicYear)
          : null;
        const isHistoricalTerm =
          selectedAcademicYear !== 'ALL' &&
          Boolean(latestAcademicYear) &&
          normalizeAy(selectedAcademicYear) !== normalizeAy(latestAcademicYear) &&
          (selectedAyBounds && latestAyBounds
            ? selectedAyBounds.start < latestAyBounds.start
            : true);
        const graduationClassYear = selectedAyBounds
          ? selectedAyBounds.end
          : null;

        const isSummerSelected =
          normalizeSemester(selectedSemester) === 'Summer';

        for (const scholar of scholarProfiles) {
          // Term Enrollments matching filter (strictly excluding drafts, pending prechecks, and rejected rows)
          const matchingEnrollments = scholar.enrollments.filter(
            (e) =>
              this.isOfficialEnrollmentForAnalytics(e) &&
              isMatchTerm(e.academic_year, e.semester),
          );
          const activeEnrollment = matchingEnrollments[0] || null;

          // Disbursements matching filter
          const matchingDisbursements = scholar.disbursements.filter((d) =>
            isMatchTerm(d.academic_year, d.semester),
          );

          // Grade Reports matching filter (strictly excluding application-phase Form 9 / Form 138 and unverified/precheck docs)
          const validScholarReports = scholar.grade_reports.filter(
            (g) =>
              !this.isForm9OrApplicationGrade(g) &&
              !this.isUnverifiedDocStatus(g.document?.status),
          );
          const matchingGrades = validScholarReports.filter((g) =>
            isMatchTerm(g.academic_year, g.semester),
          );

          if (selectedAcademicYear !== 'ALL') {
            const hasTermActivity =
              matchingEnrollments.length > 0 ||
              matchingDisbursements.length > 0 ||
              matchingGrades.length > 0;
            const isArchivedScholar = Boolean(scholar.archived_at);
            const isLatestAcademicYear =
              normalizeAy(selectedAcademicYear) ===
              normalizeAy(latestAcademicYear);

            const belongsToTermCohort =
              hasTermActivity ||
              (!isArchivedScholar && isLatestAcademicYear && !isSummerSelected);

            if (!belongsToTermCohort) {
              continue;
            }
          }

          const name =
            `${scholar.first_name || ''} ${scholar.last_name || ''}`.trim() ||
            scholar.user.email.split('@')[0];
          const school =
            scholar.school_name ||
            scholar.school?.school_name ||
            scholar.school_grading_system?.school_name ||
            'Unassigned School';
          const course = scholar.course_of_study || 'General Track';
          const track = scholar.scholarship_track || 'Academic Track';
          const enrollmentYearLevel = Number(activeEnrollment?.year_level);
          const yearLevel =
            Number.isFinite(enrollmentYearLevel) && enrollmentYearLevel > 0
              ? enrollmentYearLevel
              : scholar.current_year_level || 1;
          const gradEval = evaluateProspectusGraduation(
            scholar.prospectus,
            yearLevel,
            Boolean(scholar.archived_at),
          );
          const isGraduating = gradEval.isGraduating;

          let isGraduatedInTerm = false;
          if (scholar.archive_reason === 'GRADUATED') {
            if (selectedAcademicYear === 'ALL') {
              isGraduatedInTerm = true;
            } else {
              const recordedAcademicYears = [
                ...scholar.enrollments
                  .filter((e) => this.isOfficialEnrollmentForAnalytics(e))
                  .map((e) => e.academic_year),
                ...scholar.disbursements.map((d) => d.academic_year),
                ...scholar.grade_reports
                  .filter(
                    (g) =>
                      !this.isForm9OrApplicationGrade(g) &&
                      !this.isUnverifiedDocStatus(g.document?.status),
                  )
                  .map((g) => g.academic_year),
              ].filter((ay): ay is string => Boolean(ay && ay.trim()));

              let finalRecordedAy: string | null = null;
              let maxStartYear = -1;
              for (const ay of recordedAcademicYears) {
                const bounds = parseAyBounds(ay);
                if (bounds && bounds.start > maxStartYear) {
                  maxStartYear = bounds.start;
                  finalRecordedAy = normalizeAcademicYear(ay) || ay;
                }
              }

              if (finalRecordedAy) {
                isGraduatedInTerm = academicYearsMatchForTerm(
                  finalRecordedAy,
                  selectedAcademicYear,
                );
              } else if (scholar.archived_at && graduationClassYear !== null) {
                isGraduatedInTerm =
                  new Date(scholar.archived_at).getFullYear() ===
                  graduationClassYear;
              }
            }
          }

          const hasEnrolled = Boolean(activeEnrollment);

          const releasedDisbursement = matchingDisbursements.find((d) =>
            ['RELEASED', 'CLAIMED', 'SETTLED', 'CHECK_ISSUED'].includes(
              d.status,
            ),
          );
          const pendingDisbursement = matchingDisbursements.find((d) =>
            ['PENDING', 'AUTHORIZED'].includes(d.status),
          );

          const isDisbursed = Boolean(releasedDisbursement);
          const isPending = Boolean(pendingDisbursement);

          const disbursementStatus: 'DISBURSED' | 'PENDING' | 'NOT_APPLIED' =
            isDisbursed
              ? 'DISBURSED'
              : isPending
                ? 'PENDING'
                : 'NOT_APPLIED';

          // Assessment and amounts (never count precheck/unverified SOA drafts)
          const hasVerifiedAssessment = Boolean(
            activeEnrollment &&
              this.isAssessmentVerifiedForAnalytics(activeEnrollment),
          );
          const assessmentAmount =
            hasVerifiedAssessment && activeEnrollment
              ? Number(activeEnrollment.total_assessment || 0)
              : releasedDisbursement
                ? Number(releasedDisbursement.amount || 0)
                : pendingDisbursement
                  ? Number(pendingDisbursement.amount || 0)
                  : 0;

          const disbursedAmount = releasedDisbursement
            ? Number(releasedDisbursement.amount || 0)
            : 0;

          const scholarPendingAmount = isPending
            ? Number(pendingDisbursement?.amount || 0)
            : !isDisbursed && assessmentAmount > 0
              ? assessmentAmount
              : 0;

          totalSemesterAssessment += assessmentAmount;
          totalDisbursedAmount += disbursedAmount;
          totalPendingAmount += scholarPendingAmount;

          const latestReport = matchingGrades[0] || validScholarReports[0];
          const hasSubmittedGrade = matchingGrades.length > 0;

          // Calculate GWA
          let gwa = 0;
          if (latestReport) {
            gwa = Number(latestReport.gpa);
          } else if (scholar.prospectus?.subjects?.length) {
            const graded = scholar.prospectus.subjects.filter(
              (s) =>
                (!s.status || s.status === 'PASSED' || s.status === 'CREDITED') &&
                s.grade != null &&
                !isNaN(Number(s.grade)),
            );
            if (graded.length > 0) {
              const totalW = graded.reduce(
                (acc, s) => acc + Number(s.grade) * (Number(s.units) || 3),
                0,
              );
              const totalU = graded.reduce(
                (acc, s) => acc + (Number(s.units) || 3),
                0,
              );
              gwa =
                totalU > 0
                  ? Number((totalW / totalU).toFixed(2))
                  : Number(graded[0].grade);
            }
          }

          // Standing evaluation
          const schoolConfig = scholar.school_grading_system;
          let isCompliant = true;
          let standing: 'GOOD' | 'PROBATION' | 'AT_RISK' = 'GOOD';

          if (gwa > 0 && schoolConfig) {
            const scale = schoolConfig.grading_scale;
            const passing = Number(schoolConfig.passing_grade || 75);
            const failing = Number(schoolConfig.failing_grade || 50);
            const highest = Number(schoolConfig.highest_grade || 100);

            if (scale === 'NUMERIC_5_POINT') {
              // 1.00 is best, 3.00 passing, 5.00 failing
              const thresholdGrade = 3.0 - (gradeThreshold - 75) * 0.04;
              isCompliant = gwa <= thresholdGrade;
              if (gwa > passing) {
                standing = 'AT_RISK';
              } else if (!isCompliant) {
                standing = 'PROBATION';
              } else {
                standing = 'GOOD';
              }
            } else if (scale === 'NUMERIC_4_POINT') {
              // 4.00 is best, 2.00 passing, 1.00 failing
              const thresholdGrade = 2.0 + (gradeThreshold - 75) * 0.04;
              isCompliant = gwa >= thresholdGrade;
              if (gwa < passing) {
                standing = 'AT_RISK';
              } else if (!isCompliant) {
                standing = 'PROBATION';
              } else {
                standing = 'GOOD';
              }
            } else {
              // Standard percentage 100
              isCompliant = gwa >= gradeThreshold;
              if (gwa < passing) {
                standing = 'AT_RISK';
              } else if (!isCompliant) {
                standing = 'PROBATION';
              } else {
                standing = 'GOOD';
              }
            }
          } else if (gwa > 0) {
            isCompliant = gwa >= gradeThreshold;
            standing = isCompliant ? 'GOOD' : 'PROBATION';
          }

          // Authoritatively apply GradeReport & ScholarProfile retention/disqualification state
          const isExplicitlyClearedHistoricalReport =
            latestReport?.status === 'APPROVED' &&
            latestReport?.is_eligible !== false &&
            latestReport?.appeal_status !== 'APPROVED' &&
            latestReport?.appeal_status !== 'DENIED' &&
            latestReport?.evaluation_flag !== 'ACADEMIC_FAILURE' &&
            latestReport?.evaluation_flag !== 'BELOW_PASSING_MARK';

          const hasDeniedAppealOrTerminalFailure =
            latestReport?.appeal_status === 'DENIED' ||
            latestReport?.status === 'REJECTED' ||
            latestReport?.evaluation_flag === 'ACADEMIC_FAILURE';

          const isDisqualifiedOrArchivedForAcademicFailure =
            scholar.academic_baseline_status === 'DISCONTINUED' ||
            scholar.archive_reason === 'FAILED_SECOND_CHANCE' ||
            scholar.archive_reason === 'TERMINATED';

          if (
            hasDeniedAppealOrTerminalFailure ||
            (isDisqualifiedOrArchivedForAcademicFailure &&
              !isExplicitlyClearedHistoricalReport)
          ) {
            isCompliant = false;
            standing = 'AT_RISK';
          } else if (
            latestReport?.appeal_status === 'APPROVED' ||
            latestReport?.status === 'FLAGGED' ||
            latestReport?.is_eligible === false ||
            latestReport?.evaluation_flag === 'BELOW_PASSING_MARK' ||
            (scholar.academic_baseline_status === 'ON_PROBATION' &&
              !isExplicitlyClearedHistoricalReport)
          ) {
            isCompliant = false;
            standing = standing === 'AT_RISK' ? 'AT_RISK' : 'PROBATION';
          }

          operationalScholars.push({
            id: scholar.profile_id,
            userId: scholar.user.user_id,
            name,
            email: scholar.user.email,
            school,
            course,
            track,
            yearLevel,
            isGraduating,
            isGraduatedInTerm,
            enrollmentStatus: hasEnrolled ? 'ENROLLED' : 'NOT_ENROLLED',
            gradeStatus: hasSubmittedGrade ? 'SUBMITTED' : 'UNSUBMITTED',
            gwa: Number(gwa.toFixed(2)),
            standing,
            disbursementStatus,
            assessmentAmount,
            disbursedAmount,
            ...(scholar.archived_at
              ? { isArchived: true, archiveReason: scholar.archive_reason ?? null }
              : {}),
          });

          processedLegacyScholars.push({
            gwa: Number(gwa.toFixed(2)),
            normalizedScore: gwa,
            health: standing === 'GOOD' ? 'good' : standing === 'PROBATION' ? 'warn' : 'bad',
            isCompliant,
          });
        }

        const totalN = operationalScholars.length;

        // 4. Calculate Financial Aspect Metrics
        const disbursedScholars = operationalScholars.filter(
          (s) => s.disbursementStatus === 'DISBURSED',
        );
        const disbursedCount = disbursedScholars.length;
        const disbursedPercent =
          totalN > 0 ? Number(((disbursedCount / totalN) * 100).toFixed(1)) : 0;

        const undisbursedCount = totalN - disbursedCount;
        const undisbursedPercent =
          totalN > 0
            ? Number(((undisbursedCount / totalN) * 100).toFixed(1))
            : 0;

        const financialAspect: FinancialAspectData = {
          disbursedCount,
          disbursedPercent,
          undisbursedCount,
          undisbursedPercent,
          totalSemesterAssessment: Math.round(totalSemesterAssessment),
          totalDisbursedAmount: Math.round(totalDisbursedAmount),
          totalPendingAmount: Math.round(totalPendingAmount),
          totalScholarsCount: totalN,
        };

        // 5. Calculate Academic Aspect Metrics
        const unsubmittedGradesCount = operationalScholars.filter(
          (s) => s.gradeStatus === 'UNSUBMITTED',
        ).length;
        const unsubmittedGradesPercent =
          totalN > 0
            ? Number(((unsubmittedGradesCount / totalN) * 100).toFixed(1))
            : 0;

        const submittedGradesCount = totalN - unsubmittedGradesCount;
        const submittedGradesPercent =
          totalN > 0
            ? Number(((submittedGradesCount / totalN) * 100).toFixed(1))
            : 0;

        const notEnrolledCount = operationalScholars.filter(
          (s) => s.enrollmentStatus === 'NOT_ENROLLED',
        ).length;
        const notEnrolledPercent =
          totalN > 0
            ? Number(((notEnrolledCount / totalN) * 100).toFixed(1))
            : 0;

        const enrolledCount = totalN - notEnrolledCount;
        const enrolledPercent =
          totalN > 0 ? Number(((enrolledCount / totalN) * 100).toFixed(1)) : 0;

        const graduatingCount = operationalScholars.filter(
          (s) => s.isGraduating,
        ).length;
        const graduatingPercent =
          totalN > 0
            ? Number(((graduatingCount / totalN) * 100).toFixed(1))
            : 0;

        const graduatedCount = operationalScholars.filter(
          (s) => s.isGraduatedInTerm,
        ).length;
        const graduatedPercent =
          totalN > 0
            ? Number(((graduatedCount / totalN) * 100).toFixed(1))
            : 0;

        const undergradCount = totalN - graduatingCount;
        const undergradPercent =
          totalN > 0 ? Number(((undergradCount / totalN) * 100).toFixed(1)) : 0;

        // Academic Standing Breakdown
        const goodStandingCount = operationalScholars.filter(
          (s) => s.standing === 'GOOD',
        ).length;
        const probationCount = operationalScholars.filter(
          (s) => s.standing === 'PROBATION',
        ).length;
        const flaggedCount = operationalScholars.filter(
          (s) => s.standing === 'AT_RISK',
        ).length;

        const standingBreakdown: AcademicStandingBreakdown = {
          goodStandingCount,
          goodStandingPercent:
            totalN > 0
              ? Number(((goodStandingCount / totalN) * 100).toFixed(1))
              : 0,
          probationCount,
          probationPercent:
            totalN > 0 ? Number(((probationCount / totalN) * 100).toFixed(1)) : 0,
          flaggedCount,
          flaggedPercent:
            totalN > 0 ? Number(((flaggedCount / totalN) * 100).toFixed(1)) : 0,
          complianceRate:
            totalN > 0
              ? Number(((goodStandingCount / totalN) * 100).toFixed(1))
              : 0,
        };

        // Year-Level Distribution Breakdown (1st Year through 6th Year)
        const yearLevelMap: Record<number, number> = {
          1: 0,
          2: 0,
          3: 0,
          4: 0,
          5: 0,
          6: 0,
        };
        for (const s of operationalScholars) {
          const y = Math.min(6, Math.max(1, Math.trunc(s.yearLevel)));
          yearLevelMap[y] = (yearLevelMap[y] || 0) + 1;
        }

        const yearLevelBreakdown: YearLevelBreakdownItem[] =
          YEAR_LEVEL_BUCKETS.map(({ yearLevel, label }) => {
            const count = yearLevelMap[yearLevel] || 0;
            return {
              yearLevel,
              label,
              count,
              pct:
                totalN > 0 ? Number(((count / totalN) * 100).toFixed(1)) : 0,
            };
          });

        const academicAspect: AcademicAspectData = {
          unsubmittedGradesCount,
          unsubmittedGradesPercent,
          submittedGradesCount,
          submittedGradesPercent,
          notEnrolledCount,
          notEnrolledPercent,
          enrolledCount,
          enrolledPercent,
          graduatingCount,
          graduatingPercent,
          graduatedCount,
          graduatedPercent,
          undergradCount,
          undergradPercent,
          totalScholarsCount: totalN,
          standingBreakdown,
          yearLevelBreakdown,
        };

        // 6. Generate Dynamic Descriptive Natural Language Narratives (Capstone Requirement)
        const termLabel =
          selectedAcademicYear === 'ALL'
            ? selectedSemester
            : `${selectedSemester}, SY ${selectedAcademicYear}`;

        const scholarWord = (count: number) =>
          count === 1 ? 'scholar' : 'scholars';

        let financialSummary = isHistoricalTerm
          ? 'No scholars found for the selected historical term.'
          : 'No active scholars found for the selected semester and school year.';
        if (totalN > 0) {
          const totalProjectedStr =
            financialAspect.totalSemesterAssessment.toLocaleString();
          const totalDisbursedStr =
            financialAspect.totalDisbursedAmount.toLocaleString();
          const totalPendingStr =
            financialAspect.totalPendingAmount.toLocaleString();

          if (isHistoricalTerm) {
            const intro = `For ${termLabel}, the total recorded semester imbursement was ₱${totalProjectedStr} across ${totalN} ${scholarWord(totalN)}.`;
            if (undisbursedCount === 0) {
              const allText =
                totalN === 1
                  ? 'All 1 scholar (100%) received disbursements'
                  : `All ${totalN} scholars (100%) received disbursements`;
              financialSummary = `${intro} ${allText} totaling ₱${totalDisbursedStr}, with no remaining balance.`;
            } else if (disbursedCount === 0) {
              if (
                financialAspect.totalPendingAmount > 0 ||
                financialAspect.totalSemesterAssessment > 0
              ) {
                financialSummary = `${intro} No disbursements were recorded, leaving ${undisbursedPercent}% (${undisbursedCount} ${scholarWord(undisbursedCount)}) without a released disbursement (₱${totalPendingStr} unrecorded/undisbursed).`;
              } else {
                financialSummary = `For ${termLabel}, no semester assessments or disbursements were recorded across ${totalN} ${scholarWord(totalN)}.`;
              }
            } else {
              const pendingPhrase =
                financialAspect.totalPendingAmount > 0
                  ? ` (₱${totalPendingStr} undisbursed)`
                  : '';
              financialSummary = `${intro} ${disbursedPercent}% (${disbursedCount} ${scholarWord(disbursedCount)}) received disbursements totaling ₱${totalDisbursedStr}, while ${undisbursedPercent}% (${undisbursedCount} ${scholarWord(undisbursedCount)}) had no recorded disbursement${pendingPhrase}.`;
            }
          } else {
            const intro = `For ${termLabel}, the total projected semester imbursement is ₱${totalProjectedStr} across ${totalN} ${scholarWord(totalN)}.`;

            if (undisbursedCount === 0) {
              const allText =
                totalN === 1
                  ? 'All 1 scholar (100%) has'
                  : `All ${totalN} scholars (100%) have`;
              financialSummary = `${intro} ${allText} received disbursements totaling ₱${totalDisbursedStr}, with no pending allocations remaining.`;
            } else if (disbursedCount === 0) {
              if (
                financialAspect.totalPendingAmount > 0 ||
                financialAspect.totalSemesterAssessment > 0
              ) {
                financialSummary = `${intro} No disbursements have been released yet, with ${undisbursedPercent}% (${undisbursedCount} ${scholarWord(undisbursedCount)}) awaiting release totaling ₱${totalPendingStr} in pending allocations.`;
              } else {
                financialSummary = `For ${termLabel}, no semester assessments or disbursements have been recorded yet across ${totalN} ${scholarWord(totalN)}.`;
              }
            } else {
              const pendingPhrase =
                financialAspect.totalPendingAmount > 0
                  ? ` representing ₱${totalPendingStr} in pending allocations`
                  : '';
              financialSummary = `${intro} Currently, ${disbursedPercent}% (${disbursedCount} ${scholarWord(disbursedCount)}) ${disbursedCount === 1 ? 'has' : 'have'} received disbursements totaling ₱${totalDisbursedStr}, while ${undisbursedPercent}% (${undisbursedCount} ${scholarWord(undisbursedCount)}) ${undisbursedCount === 1 ? 'is' : 'are'} awaiting release${pendingPhrase}.`;
            }
          }
        }

        let academicSummary = isHistoricalTerm
          ? 'No scholars found for the selected historical term.'
          : 'No active scholars found for the selected semester and school year.';
        if (totalN > 0) {
          let enrollmentClause = '';
          if (isHistoricalTerm) {
            if (notEnrolledCount === 0) {
              enrollmentClause = `For ${termLabel}, ${enrolledPercent}% (${enrolledCount} ${scholarWord(enrolledCount)}) completed enrollment.`;
            } else if (enrolledCount === 0) {
              enrollmentClause = `For ${termLabel}, ${notEnrolledPercent}% (${notEnrolledCount} ${scholarWord(notEnrolledCount)}) had no enrollment record on file.`;
            } else {
              enrollmentClause = `For ${termLabel}, ${enrolledPercent}% (${enrolledCount} ${scholarWord(enrolledCount)}) completed enrollment, while ${notEnrolledPercent}% (${notEnrolledCount} ${scholarWord(notEnrolledCount)}) had no enrollment record on file.`;
            }
          } else if (notEnrolledCount === 0) {
            enrollmentClause = `For ${termLabel}, ${enrolledPercent}% (${enrolledCount} ${scholarWord(enrolledCount)}) ${enrolledCount === 1 ? 'has' : 'have'} completed enrollment.`;
          } else if (enrolledCount === 0) {
            enrollmentClause = `For ${termLabel}, ${notEnrolledPercent}% (${notEnrolledCount} ${scholarWord(notEnrolledCount)}) ${notEnrolledCount === 1 ? 'has' : 'have'} not enrolled yet.`;
          } else {
            enrollmentClause = `For ${termLabel}, ${enrolledPercent}% (${enrolledCount} ${scholarWord(enrolledCount)}) have completed enrollment, while ${notEnrolledPercent}% (${notEnrolledCount} ${scholarWord(notEnrolledCount)}) have not enrolled yet.`;
          }

          let gradesClause = '';
          if (unsubmittedGradesCount === 0) {
            const allGradesText = isHistoricalTerm
              ? `All ${submittedGradesCount === 1 ? '1 scholar (100%)' : `${submittedGradesCount} scholars (100%)`}`
              : submittedGradesCount === 1
                ? 'All 1 scholar (100%) has'
                : `All ${submittedGradesCount} scholars (100%) have`;
            gradesClause = `${allGradesText} submitted their grade reports`;
          } else if (submittedGradesCount === 0) {
            gradesClause = isHistoricalTerm
              ? `${unsubmittedGradesPercent}% (${unsubmittedGradesCount} ${scholarWord(unsubmittedGradesCount)}) had no recorded grade report`
              : `${unsubmittedGradesPercent}% (${unsubmittedGradesCount} ${scholarWord(unsubmittedGradesCount)} ${unsubmittedGradesCount === 1 ? 'has' : 'have'}) not yet submitted their grades`;
          } else {
            gradesClause = isHistoricalTerm
              ? `${submittedGradesPercent}% (${submittedGradesCount} ${scholarWord(submittedGradesCount)}) submitted grades while ${unsubmittedGradesPercent}% (${unsubmittedGradesCount} ${scholarWord(unsubmittedGradesCount)}) had no recorded grade report`
              : `${submittedGradesPercent}% (${submittedGradesCount} ${scholarWord(submittedGradesCount)}) submitted grades while ${unsubmittedGradesPercent}% (${unsubmittedGradesCount} ${scholarWord(unsubmittedGradesCount)} ${unsubmittedGradesCount === 1 ? 'has' : 'have'}) not yet submitted their grades`;
          }

          const standingParts: string[] = [];
          if (goodStandingCount > 0) {
            standingParts.push(`${goodStandingCount} in good standing`);
          }
          if (probationCount > 0) {
            standingParts.push(`${probationCount} on probation`);
          }
          if (flaggedCount > 0) {
            standingParts.push(
              `${flaggedCount} at risk or disqualified due to retention deficiency`,
            );
          }
          const standingSuffix =
            standingParts.length > 0 ? ` (${standingParts.join(', ')})` : '';

          let graduatingClause = '';
          if (isHistoricalTerm) {
            if (graduatedCount > 0) {
              graduatingClause = ` Additionally, ${graduatedPercent}% (${graduatedCount} ${scholarWord(graduatedCount)}) graduated in SY ${selectedAcademicYear}.`;
            } else if (graduatingCount > 0) {
              graduatingClause = ` Additionally, ${graduatingPercent}% (${graduatingCount} ${scholarWord(graduatingCount)}) belonged to the senior cohort (4th year and above).`;
            }
          } else if (graduatingCount > 0) {
            graduatingClause = ` Additionally, ${graduatingPercent}% (${graduatingCount} ${scholarWord(graduatingCount)} ${graduatingCount === 1 ? 'is' : 'are'}) graduating this academic year.`;
          }

          academicSummary = `${enrollmentClause} ${gradesClause}${standingSuffix}.${graduatingClause}`;
        }

        const descriptiveNarratives: DescriptiveNarratives = {
          financialSummary,
          academicSummary,
        };

        const filterOptions: AnalyticsFilterOptions = {
          availableSemesters,
          availableAcademicYears,
          termsByYear: formattedTermsByYear,
          selectedSemester,
          selectedAcademicYear,
          isHistoricalTerm,
          graduationClassYear,
        };

        const overallStats = this.computeDescriptiveStats(
          processedLegacyScholars,
        );

        return {
          filterOptions,
          financialAspect,
          academicAspect,
          descriptiveNarratives,
          scholars: operationalScholars,
          globalThresholdPercent: gradeThreshold,
          overallStats,
        };
      },
      60 * 1000,
      forceRefresh,
    );
  }

  /**
   * LLM Chart & Metric Explanation Service.
   * Generates structured narrative explanations with Gemini API (or plain-English heuristic fallback).
   */
  async explainChartWithAi(dto: ExplainChartDto) {
    const geminiApiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY;

    if (geminiApiKey) {
      try {
        const prompt = `You are a helpful scholarship advisor for ViaScholar (CRDC Scholarship Program).
Your role is to explain scholarship financial disbursements and academic progress to coordinators and grantors in clear, simple everyday English.

Chart or Metric: ${dto.title || dto.chartType}
Category / Group: ${dto.category || 'All Scholars'}
Metrics & Data: ${JSON.stringify(dto.metrics, null, 2)}
${dto.dataPoints ? `Sample Data Points: ${JSON.stringify(dto.dataPoints.slice(0, 10), null, 2)}` : ''}

CRITICAL GUIDELINES:
1. Speak in friendly, plain English. Do NOT use mathematical jargon like standard deviation, variance, quartiles, or Greek symbols.
2. Focus strictly on current descriptive status: how many scholars are disbursed vs undisbursed, missing requirements (grades, enrollment), or graduating (or, if metrics.isHistoricalTerm is true, refer to the selected term in past tense and distinguish graduated scholars from active graduating cohorts).
3. NEVER mention or show time-series trends, forecasting, or historical drift — coordinators and grantors do NOT include trends in their reports.
4. Provide practical next steps for coordinator requirement collection and grantor funding allocation.

Return ONLY a JSON object with this exact structure (no markdown formatting, no code blocks):
{
  "summary": "2-3 short, clear sentences summarizing what this data shows in simple terms.",
  "statisticalInterpretation": "A simple paragraph explaining what the numbers mean for this semester's operations without mathematical jargon or trends.",
  "recommendations": ["Clear next step or action 1", "Clear next step or action 2"],
  "keyHighlights": ["Key highlight or number 1", "Key highlight or number 2"]
}`;

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          },
        );

        if (response.ok) {
          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            const cleanJson = text
              .replace(/```json/g, '')
              .replace(/```/g, '')
              .trim();
            const parsed = JSON.parse(cleanJson);
            return parsed;
          }
        }
      } catch (err) {
        this.logger.warn(
          `Gemini API explanation failed, falling back to heuristic explanation: ${err}`,
        );
      }
    }

    // Heuristic Fallback (plain language, non-technical, zero trends)
    return this.generateStatisticalHeuristicExplanation(dto);
  }

  /**
   * Plain-language heuristic engine when offline or no API key configured.
   */
  private generateStatisticalHeuristicExplanation(dto: ExplainChartDto) {
    if (dto.chartType === 'FINANCIAL_DISBURSEMENT_SUMMARY') {
      const m = dto.metrics || {};
      const isHistoricalTerm = Boolean(m.isHistoricalTerm);
      const disbursedPct = Number(m.disbursedPercent || 0);
      const undisbursedPct = Number(m.undisbursedPercent || 0);
      const disbursedCount = Number(m.disbursedCount || 0);
      const undisbursedCount = Number(m.undisbursedCount || 0);
      const totalAssessment = Number(m.totalSemesterAssessment || 0);
      const totalDisbursed = Number(m.totalDisbursedAmount || 0);
      const totalPending = Number(m.totalPendingAmount || 0);

      if (isHistoricalTerm) {
        return {
          summary: `${disbursedPct}% of scholars (${disbursedCount}) received their semester disbursement, while ${undisbursedPct}% (${undisbursedCount}) had no recorded disbursement for this term.`,
          statisticalInterpretation: `Out of the ₱${totalAssessment.toLocaleString()} assessed for this historical term, ₱${totalDisbursed.toLocaleString()} was disbursed to scholars or schools, leaving ₱${totalPending.toLocaleString()} undisbursed or unrecorded.`,
          recommendations: [
            'Reconcile any unrecorded historical disbursements against archived SOA and Official Receipt records.',
            'Review undisbursed scholar accounts to confirm whether scholars withdrew or became ineligible prior to release.',
          ],
          keyHighlights: [
            `Disbursed Scholars: ${disbursedPct}% (${disbursedCount})`,
            `Undisbursed Scholars: ${undisbursedPct}% (${undisbursedCount})`,
            `Total Disbursed: ₱${totalDisbursed.toLocaleString()}`,
            `Undisbursed Balance: ₱${totalPending.toLocaleString()}`,
          ],
        };
      }

      return {
        summary: `${disbursedPct}% of scholars (${disbursedCount}) have received their semester disbursement, while ${undisbursedPct}% (${undisbursedCount}) are waiting for funds release.`,
        statisticalInterpretation: `Out of the total ₱${totalAssessment.toLocaleString()} needed for this semester, ₱${totalDisbursed.toLocaleString()} has already been released to scholars or schools. The remaining ₱${totalPending.toLocaleString()} is queued for grantor authorization or awaiting delayed SOA submissions from scholars who missed the initial deadline.`,
        recommendations: [
          'Group all verified SOAs into the current batch for grantor endorsement.',
          'Send follow-up reminders to scholars who submitted late so their disbursements can be prepared in the next cycle.',
        ],
        keyHighlights: [
          `Disbursed Scholars: ${disbursedPct}% (${disbursedCount})`,
          `Undisbursed Scholars: ${undisbursedPct}% (${undisbursedCount})`,
          `Funds Disbursed: ₱${totalDisbursed.toLocaleString()}`,
          `Pending Imbursement: ₱${totalPending.toLocaleString()}`,
        ],
      };
    }

    if (dto.chartType === 'ACADEMIC_COMPLIANCE_SUMMARY') {
      const m = dto.metrics || {};
      const isHistoricalTerm = Boolean(m.isHistoricalTerm);
      const unsubmittedGradesPct = Number(m.unsubmittedGradesPercent || 0);
      const unsubmittedGradesCount = Number(m.unsubmittedGradesCount || 0);
      const notEnrolledPct = Number(m.notEnrolledPercent || 0);
      const notEnrolledCount = Number(m.notEnrolledCount || 0);
      const graduatingPct = Number(m.graduatingPercent || 0);
      const graduatingCount = Number(m.graduatingCount || 0);

      if (isHistoricalTerm) {
        const graduatedPct = Number(m.graduatedPercent ?? graduatingPct);
        const graduatedCount = Number(m.graduatedCount ?? graduatingCount);

        return {
          summary: `${notEnrolledPct}% of scholars had no enrollment record on file, ${unsubmittedGradesPct}% had missing grade records, and ${graduatedPct}% graduated during this term.`,
          statisticalInterpretation: `Historical academic snapshots capture verified enrollment, grade reports, and finalized graduation outcomes archived for the selected school year.`,
          recommendations: [
            'Audit missing historical COR and grade report records if legacy documents still need archival encoding.',
            'Verify that all graduating seniors from this cohort have their GRADUATED alumni status recorded.',
          ],
          keyHighlights: [
            `Missing Grade Records: ${unsubmittedGradesPct}% (${unsubmittedGradesCount} scholars)`,
            `No Enrollment Record: ${notEnrolledPct}% (${notEnrolledCount} scholars)`,
            `Graduated Scholars: ${graduatedPct}% (${graduatedCount} scholars)`,
          ],
        };
      }

      return {
        summary: `${notEnrolledPct}% of scholars have not yet enrolled, ${unsubmittedGradesPct}% have pending grade submissions, and ${graduatingPct}% are in their graduating year.`,
        statisticalInterpretation: `Academic tracking ensures scholars maintain active enrollment and submit required proof of grades before funding. Scholars with unsubmitted grades or missing enrollment records cannot receive term disbursements until their documents are verified.`,
        recommendations: [
          'Follow up with scholars who have not submitted their Certificate of Registration (COR).',
          'Coordinate with the registrar or scholars regarding missing official grade reports.',
          'Review the graduating cohort to prepare for graduation clearances and diploma tracking.',
        ],
        keyHighlights: [
          `Unsubmitted Grades: ${unsubmittedGradesPct}% (${unsubmittedGradesCount} scholars)`,
          `Not Enrolled Yet: ${notEnrolledPct}% (${notEnrolledCount} scholars)`,
          `Graduating Scholars: ${graduatingPct}% (${graduatingCount} scholars)`,
        ],
      };
    }

    if (dto.chartType === 'ACADEMIC_STANDING') {
      const m = dto.metrics || {};
      const goodCount = Number(m.goodStandingCount || 0);
      const probCount = Number(m.probationCount || 0);
      const flaggedCount = Number(m.flaggedCount || 0);
      const complianceRate = Number(m.complianceRate || 0);

      return {
        summary: `${complianceRate}% of scholars meet the required grade retention criteria, with ${goodCount} in good standing.`,
        statisticalInterpretation: `Scholars in good standing continue receiving regular tuition assistance. Scholars on watch (${probCount}) or at risk (${flaggedCount}) receive additional academic support and counseling to recover their standing.`,
        recommendations: [
          'Schedule mentoring sessions for scholars on academic probation.',
          'Recognize scholars in good standing for their consistent performance.',
        ],
        keyHighlights: [
          `Meeting Retention Mark: ${complianceRate}%`,
          `Good Standing: ${goodCount}`,
          `On Watch / Probation: ${probCount}`,
          `At Risk: ${flaggedCount}`,
        ],
      };
    }

    if (dto.chartType === 'YEAR_LEVEL_DISTRIBUTION') {
      const m = dto.metrics || {};
      const list = (m.yearLevelBreakdown as YearLevelBreakdownItem[]) || [];

      return {
        summary: `The scholarship cohort is distributed across academic year levels from 1st Year through 6th Year.`,
        statisticalInterpretation: `Tracking year levels provides clear visibility into student progression and the volume of scholars approaching graduation. This assists the coordinator and grantor in forecasting future scholarship slot turnover.`,
        recommendations: [
          'Ensure upper-year scholars receive guidance for on-the-job training and graduation requirements.',
          'Plan upcoming recruitment intake based on the graduating cohort size.',
        ],
        keyHighlights: list.map((item) => `${item.label}: ${item.count} (${item.pct}%)`),
      };
    }

    return {
      summary: 'Descriptive summary of scholarship operational metrics for the current semester.',
      statisticalInterpretation: 'This report summarizes current scholar performance, enrollment status, and funding release without time-series forecasting.',
      recommendations: [
        'Monitor document submissions regularly.',
        'Review pending items before the upcoming disbursement cycle.',
      ],
      keyHighlights: ['Status: Active Semester Report'],
    };
  }
}
