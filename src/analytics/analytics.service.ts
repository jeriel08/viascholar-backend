import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { Role } from '../generated/prisma/enums.js';
import { AnalyticsQueryDto, ExplainChartDto } from './dto/analytics.dto.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';

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
  enrollmentStatus: 'ENROLLED' | 'NOT_ENROLLED';
  gradeStatus: 'SUBMITTED' | 'UNSUBMITTED';
  gwa: number;
  standing: 'GOOD' | 'PROBATION' | 'AT_RISK';
  disbursementStatus: 'DISBURSED' | 'PENDING' | 'NOT_APPLIED';
  assessmentAmount: number;
  disbursedAmount: number;
}

export interface AnalyticsFilterOptions {
  availableSemesters: string[];
  availableAcademicYears: string[];
  termsByYear?: Record<string, string[]>;
  selectedSemester: string;
  selectedAcademicYear: string;
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
          allGradeReports,
        ] = await Promise.all([
          this.prisma.systemSetting.findFirst(),
          this.prisma.scholarProfile.findMany({
            where: {
              user: { role: Role.SCHOLAR, is_active: true },
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
                    },
                  },
                },
                orderBy: { submitted_at: 'desc' },
              },
              enrollments: {
                orderBy: { created_at: 'desc' },
              },
              disbursements: {
                orderBy: { disbursement_id: 'desc' },
              },
              prospectus: {
                include: {
                  subjects: {
                    where: { status: { in: ['PASSED', 'CREDITED'] } },
                    select: { units: true, grade: true },
                  },
                },
              },
            },
            orderBy: { profile_id: 'desc' },
          }),
          this.prisma.termEnrollment.findMany({
            select: {
              academic_year: true,
              semester: true,
              total_assessment: true,
              status: true,
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
          this.prisma.gradeReport.findMany({
            select: {
              academic_year: true,
              semester: true,
              document: {
                select: {
                  document_type: true,
                  label: true,
                },
              },
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
            foundYears.add(cleanAy);
            if (!termsByYear[cleanAy]) {
              termsByYear[cleanAy] = new Set<string>();
            }
            termsByYear[cleanAy].add(cleanSem);
            foundSemesters.add(cleanSem);
          }
        };

        for (const e of allEnrollments) {
          registerTerm(e.academic_year, e.semester);
        }
        for (const d of allDisbursements) {
          registerTerm(d.academic_year, d.semester);
        }
        for (const g of allGradeReports) {
          if (!this.isForm9OrApplicationGrade(g)) {
            registerTerm(g.academic_year, g.semester);
          }
        }

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
        const normalizeAy = (ayStr?: string | null) => {
          if (!ayStr) return '';
          const trimmed = ayStr.trim().toLowerCase();
          const parts = trimmed.split('-');
          if (parts.length === 2 && parts[1].length === 2) {
            return `${parts[0]}-20${parts[1]}`;
          }
          return trimmed;
        };

        // 2. Resolve Active / Filtered Term
        const selectedAcademicYear =
          query.academicYear &&
          (availableAcademicYears.some((y) => normalizeAy(y) === normalizeAy(query.academicYear)) ||
            query.academicYear === 'ALL')
            ? query.academicYear
            : availableAcademicYears[0];

        // Semesters valid for the selected academic year
        const yearSemesters =
          selectedAcademicYear !== 'ALL' &&
          formattedTermsByYear[selectedAcademicYear]?.length > 0
            ? formattedTermsByYear[selectedAcademicYear]
            : availableSemesters;

        const querySem = query.semester?.trim();
        const selectedSemester =
          querySem && yearSemesters.some((s) => s.toLowerCase() === querySem.toLowerCase())
            ? querySem
            : yearSemesters[0] || availableSemesters[0] || '1st Semester';

        const isMatchTerm = (ay?: string | null, sem?: string | null) => {
          const normAy = normalizeAy(ay);
          const normSelectedAy = normalizeAy(selectedAcademicYear);
          const matchAy =
            selectedAcademicYear === 'ALL' ||
            !normAy ||
            normAy === normSelectedAy;
          const matchSem =
            !sem ||
            sem.trim().toLowerCase() === selectedSemester.trim().toLowerCase();
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

        for (const scholar of scholarProfiles) {
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
          const yearLevel = scholar.current_year_level || 1;
          const isGraduating = yearLevel >= 4;

          // Term Enrollments matching filter
          const matchingEnrollments = scholar.enrollments.filter((e) =>
            isMatchTerm(e.academic_year, e.semester),
          );
          const activeEnrollment = matchingEnrollments[0] || null;
          const hasEnrolled = Boolean(
            activeEnrollment &&
              activeEnrollment.status !== 'REJECTED' &&
              activeEnrollment.status !== 'DRAFT',
          );

          // Disbursements matching filter
          const matchingDisbursements = scholar.disbursements.filter((d) =>
            isMatchTerm(d.academic_year, d.semester),
          );
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

          // Assessment and amounts
          const assessmentAmount = activeEnrollment
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

          // Grade Reports matching filter (strictly excluding application-phase Form 9 / Form 138)
          const validScholarReports = scholar.grade_reports.filter(
            (g) => !this.isForm9OrApplicationGrade(g),
          );
          const matchingGrades = validScholarReports.filter((g) =>
            isMatchTerm(g.academic_year, g.semester),
          );
          const latestReport = matchingGrades[0] || validScholarReports[0];
          const hasSubmittedGrade = matchingGrades.length > 0;

          // Calculate GWA
          let gwa = 0;
          if (latestReport) {
            gwa = Number(latestReport.gpa);
          } else if (scholar.prospectus?.subjects?.length) {
            const graded = scholar.prospectus.subjects.filter(
              (s) => s.grade != null && !isNaN(Number(s.grade)),
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
            enrollmentStatus: hasEnrolled ? 'ENROLLED' : 'NOT_ENROLLED',
            gradeStatus: hasSubmittedGrade ? 'SUBMITTED' : 'UNSUBMITTED',
            gwa: Number(gwa.toFixed(2)),
            standing,
            disbursementStatus,
            assessmentAmount,
            disbursedAmount,
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

        // Year-Level Distribution Breakdown
        const yearLevelMap: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
        for (const s of operationalScholars) {
          const y = Math.min(4, Math.max(1, s.yearLevel));
          yearLevelMap[y] = (yearLevelMap[y] || 0) + 1;
        }

        const yearLevelBreakdown: YearLevelBreakdownItem[] = [
          {
            yearLevel: 1,
            label: '1st Year',
            count: yearLevelMap[1] || 0,
            pct:
              totalN > 0
                ? Number((((yearLevelMap[1] || 0) / totalN) * 100).toFixed(1))
                : 0,
          },
          {
            yearLevel: 2,
            label: '2nd Year',
            count: yearLevelMap[2] || 0,
            pct:
              totalN > 0
                ? Number((((yearLevelMap[2] || 0) / totalN) * 100).toFixed(1))
                : 0,
          },
          {
            yearLevel: 3,
            label: '3rd Year',
            count: yearLevelMap[3] || 0,
            pct:
              totalN > 0
                ? Number((((yearLevelMap[3] || 0) / totalN) * 100).toFixed(1))
                : 0,
          },
          {
            yearLevel: 4,
            label: '4th Year (Graduating)',
            count: yearLevelMap[4] || 0,
            pct:
              totalN > 0
                ? Number((((yearLevelMap[4] || 0) / totalN) * 100).toFixed(1))
                : 0,
          },
        ];

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
          undergradCount,
          undergradPercent,
          totalScholarsCount: totalN,
          standingBreakdown,
          yearLevelBreakdown,
        };

        // 6. Generate Descriptive Natural Language Narratives (Capstone Requirement)
        const termLabel =
          selectedAcademicYear === 'ALL'
            ? selectedSemester
            : `${selectedSemester}, SY ${selectedAcademicYear}`;

        const financialSummary =
          totalN === 0
            ? 'No active scholars found for the selected semester and school year.'
            : `For ${termLabel}, the total projected semester imbursement is ₱${financialAspect.totalSemesterAssessment.toLocaleString()} across ${totalN} scholars. Currently, ${disbursedPercent}% (${disbursedCount} ${disbursedCount === 1 ? 'scholar' : 'scholars'}) have received their disbursements totaling ₱${financialAspect.totalDisbursedAmount.toLocaleString()}, while ${undisbursedPercent}% (${undisbursedCount} ${undisbursedCount === 1 ? 'scholar' : 'scholars'}) have not been given disbursements yet, representing ₱${financialAspect.totalPendingAmount.toLocaleString()} in pending allocations.`;

        const academicSummary =
          totalN === 0
            ? 'No active scholars found for the selected semester and school year.'
            : `For ${termLabel}, ${enrolledPercent}% (${enrolledCount} ${enrolledCount === 1 ? 'scholar' : 'scholars'}) have completed enrollment, while ${notEnrolledPercent}% (${notEnrolledCount} ${notEnrolledCount === 1 ? 'scholar' : 'scholars'}) have not enrolled yet. In terms of academic grades, ${unsubmittedGradesPercent}% (${unsubmittedGradesCount} ${unsubmittedGradesCount === 1 ? 'scholar has' : 'scholars have'}) not yet submitted their grades, and ${graduatingPercent}% (${graduatingCount} ${graduatingCount === 1 ? 'scholar is' : 'scholars are'}) graduating this academic year.`;

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
2. Focus strictly on current descriptive status: how many scholars are disbursed vs undisbursed, missing requirements (grades, enrollment), or graduating.
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
      const disbursedPct = Number(m.disbursedPercent || 0);
      const undisbursedPct = Number(m.undisbursedPercent || 0);
      const disbursedCount = Number(m.disbursedCount || 0);
      const undisbursedCount = Number(m.undisbursedCount || 0);
      const totalAssessment = Number(m.totalSemesterAssessment || 0);
      const totalDisbursed = Number(m.totalDisbursedAmount || 0);
      const totalPending = Number(m.totalPendingAmount || 0);

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
      const unsubmittedGradesPct = Number(m.unsubmittedGradesPercent || 0);
      const unsubmittedGradesCount = Number(m.unsubmittedGradesCount || 0);
      const notEnrolledPct = Number(m.notEnrolledPercent || 0);
      const notEnrolledCount = Number(m.notEnrolledCount || 0);
      const graduatingPct = Number(m.graduatingPercent || 0);
      const graduatingCount = Number(m.graduatingCount || 0);

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
        summary: `The scholarship cohort is distributed across undergraduate year levels, leading up to the graduating class.`,
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
