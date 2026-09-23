import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { Role } from '../generated/prisma/enums.js';
import { AnalyticsQueryDto, ExplainChartDto } from './dto/analytics.dto.js';

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

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Calculates complete descriptive statistics (Mean, Std Dev, Quartiles, Compliance Rate)
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

    // Variance: sum((x - mean)^2) / N
    const sumSqDiff = gwas.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
    const variance = Number((sumSqDiff / count).toFixed(4));
    const standardDeviation = Number(Math.sqrt(variance).toFixed(2));

    // Sorted for Quartiles & Min/Max
    const sorted = [...gwas].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    const getPercentile = (arr: number[], p: number): number => {
      const idx = (arr.length - 1) * p;
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      const weight = idx - lower;
      if (lower === upper) return arr[lower];
      return Number((arr[lower] * (1 - weight) + arr[upper] * weight).toFixed(2));
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
   * Main descriptive analytics endpoint for Grantor & Coordinator dashboards.
   * Computes Mean GWA, Standard Deviation, Compliance Rate, Percentiles, Document Compliance, and Disbursements.
   */
  async getDescriptiveAnalytics(query: AnalyticsQueryDto) {
    const [systemSetting, scholarProfiles, applications, disbursements, documents] =
      await Promise.all([
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
            grade_reports: {
              orderBy: { submitted_at: 'desc' },
              take: 1,
            },
            prospectus: {
              include: {
                subjects: {
                  where: { status: { in: ['PASSED', 'CREDITED'] } },
                  select: { units: true, grade: true },
                },
              },
            },
            documents: true,
            disbursements: true,
          },
          orderBy: { profile_id: 'desc' },
        }),
        this.prisma.application.findMany({
          where: {
            scholar_profile: {
              user: { role: Role.APPLICANT, is_active: true },
            },
          },
          include: {
            scholar_profile: {
              select: {
                scholarship_track: true,
                school_name: true,
                course_of_study: true,
              },
            },
          },
        }),
        this.prisma.disbursement.findMany({
          orderBy: { disbursement_id: 'desc' },
          include: {
            scholar_profile: {
              select: {
                first_name: true,
                last_name: true,
                scholarship_track: true,
                school_name: true,
                course_of_study: true,
              },
            },
          },
        }),
        this.prisma.scholarDocument.findMany({
          where: {
            scholar_profile: {
              user: { role: Role.SCHOLAR, is_active: true },
            },
          },
        }),
      ]);

    const gradeThreshold = systemSetting?.grade_threshold
      ? Number(systemSetting.grade_threshold)
      : 90.0;

    // 1. Process individual scholar statistics & health
    const processedScholars = scholarProfiles.map((scholar) => {
      const name =
        `${scholar.first_name || ''} ${scholar.last_name || ''}`.trim() ||
        scholar.user.email.split('@')[0];
      const school =
        scholar.school_name ||
        scholar.school_grading_system?.school_name ||
        'Unassigned School';
      const course = scholar.course_of_study || 'General Track';
      const track = scholar.scholarship_track || 'Academic Track';

      let gwa = 0;
      const latestReport = scholar.grade_reports[0];
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
        } else {
          gwa = scholar.school_grading_system?.highest_grade
            ? Number(scholar.school_grading_system.highest_grade)
            : (scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT' ? 1.0 : (scholar.school_grading_system?.grading_scale === 'NUMERIC_4_POINT' ? 4.0 : gradeThreshold));
        }
      } else {
        gwa = scholar.school_grading_system?.highest_grade
          ? Number(scholar.school_grading_system.highest_grade)
          : (scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT' ? 1.0 : (scholar.school_grading_system?.grading_scale === 'NUMERIC_4_POINT' ? 4.0 : gradeThreshold));
      }

      const schoolConfig = scholar.school_grading_system;
      const isCompliant = this.settingsService.evaluateGwaThreshold(
        gwa,
        gradeThreshold,
        schoolConfig,
      );

      const isOnProbation =
        scholar.academic_baseline_status === 'ON_PROBATION' ||
        latestReport?.appeal_status === 'APPROVED';
      const isFlagged =
        latestReport &&
        (latestReport.status === 'FLAGGED' ||
          latestReport.evaluation_flag === 'ACADEMIC_FAILURE' ||
          latestReport.evaluation_flag === 'BELOW_PASSING_MARK' ||
          latestReport.is_eligible === false);

      const highest = Number(
        schoolConfig?.highest_grade ??
          (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
            ? 1.0
            : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
              ? 4.0
              : 100),
      );
      const passing = Number(
        schoolConfig?.passing_grade ??
          (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
            ? 3.0
            : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
              ? 2.0
              : 75),
      );
      const failing = Number(
        schoolConfig?.failing_grade ??
          (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
            ? 5.0
            : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
              ? 1.0
              : 50),
      );
      const isInverted = highest < failing;
      const isFailingGrade = isInverted ? gwa > passing : gwa < passing;

      let health: 'good' | 'warn' | 'bad' = 'good';
      if (isFlagged || (gwa > 0 && isFailingGrade)) {
        health = 'bad';
      } else if (isOnProbation || (gwa > 0 && !isCompliant)) {
        health = 'warn';
      } else {
        health = 'good';
      }

      // Normalized 100-point equivalent for cross-system peer ranking
      let normalizedScore = 0;
      if (!schoolConfig || schoolConfig.grading_scale === 'PERCENTAGE_100') {
        normalizedScore = gwa;
      } else if (schoolConfig.grading_scale === 'NUMERIC_4_POINT') {
        // 2.0 = 75%, 4.0 = 100%
        normalizedScore = Math.max(50, Math.min(100, 75 + ((gwa - 2.0) / 2.0) * 25));
      } else if (schoolConfig.grading_scale === 'NUMERIC_5_POINT') {
        // 3.0 = 75%, 1.0 = 100%
        normalizedScore = Math.max(50, Math.min(100, 75 + ((3.0 - gwa) / 2.0) * 25));
      } else {
        normalizedScore = gwa;
      }

      return {
        id: scholar.profile_id,
        userId: scholar.user.user_id,
        name,
        email: scholar.user.email,
        school,
        course,
        track,
        gwa: Number(gwa.toFixed(2)),
        normalizedScore: Number(normalizedScore.toFixed(2)),
        health,
        isCompliant,
        gradingScale: schoolConfig?.grading_scale || 'PERCENTAGE_100',
        academicBaselineStatus: scholar.academic_baseline_status,
      };
    });

    // 2. Overall Cohort Descriptive Statistics
    const overallStats = this.computeDescriptiveStats(processedScholars);

    // 3. Compute Percentile Rank for each scholar relative to all peers
    const totalN = processedScholars.length;
    const scholarsWithPercentile = processedScholars
      .map((sc) => {
        // Count how many peers have a lower normalized score
        const lowerCount = processedScholars.filter(
          (other) => other.normalizedScore < sc.normalizedScore,
        ).length;
        const equalCount = processedScholars.filter(
          (other) => other.normalizedScore === sc.normalizedScore,
        ).length;
        const percentileRank =
          totalN > 0
            ? Number((((lowerCount + 0.5 * equalCount) / totalN) * 100).toFixed(1))
            : 100;

        return {
          ...sc,
          percentileRank,
        };
      })
      .sort((a, b) => b.normalizedScore - a.normalizedScore);

    // 4. Categorical Breakdown (By Course, Track, School)
    const groupByKey = (key: 'course' | 'track' | 'school') => {
      const groups: Record<string, typeof processedScholars> = {};
      for (const sc of processedScholars) {
        const val = sc[key] || 'Unassigned';
        if (!groups[val]) groups[val] = [];
        groups[val].push(sc);
      }

      return Object.entries(groups).map(([category, items]) => {
        const stats = this.computeDescriptiveStats(items);
        return {
          category,
          ...stats,
        };
      }).sort((a, b) => b.count - a.count);
    };

    const courseBreakdown = groupByKey('course');
    const trackBreakdown = groupByKey('track');
    const schoolBreakdown = groupByKey('school');

    // 5. Document Compliance Analytics
    const totalDocs = documents.length;
    const verifiedDocs = documents.filter((d) => d.status === 'VERIFIED').length;
    const pendingDocs = documents.filter(
      (d) =>
        d.status === 'PENDING' ||
        d.status === 'PASSED_PRECHECK' ||
        d.status === 'STUDENT_CONFIRMED',
    ).length;
    const rejectedDocs = documents.filter(
      (d) => d.status === 'REJECTED' || d.status === 'NEEDS_REUPLOAD',
    ).length;
    const docComplianceRate =
      totalDocs > 0 ? Number(((verifiedDocs / totalDocs) * 100).toFixed(1)) : 100;

    // 6. Financial Disbursements Summary (Grantor Focus)
    const totalDisbursedSum = disbursements
      .filter((d) => ['RELEASED', 'SETTLED', 'CLAIMED'].includes(d.status))
      .reduce((acc, d) => acc + Number(d.amount), 0);

    const pendingDisbursedSum = disbursements
      .filter((d) => ['PENDING', 'AUTHORIZED'].includes(d.status))
      .reduce((acc, d) => acc + Number(d.amount), 0);

    const totalOrSubmitted = disbursements.filter((d) => Boolean(d.or_document_id)).length;
    const claimedOrReleasedCount = disbursements.filter((d) =>
      ['RELEASED', 'CLAIMED', 'SETTLED'].includes(d.status),
    ).length;
    const orComplianceRate =
      claimedOrReleasedCount > 0
        ? Number(((totalOrSubmitted / claimedOrReleasedCount) * 100).toFixed(1))
        : 100;

    // Disbursement breakdown by track (guarantee all 3 program tracks appear)
    const DEFAULT_TRACKS = [
      'Academic Track',
      'Financial Need Track',
      'Returning Scholar',
    ];
    const disbByTrack: Record<string, number> = {};
    for (const t of DEFAULT_TRACKS) {
      disbByTrack[t] = 0;
    }
    for (const d of disbursements) {
      if (['RELEASED', 'SETTLED', 'CLAIMED'].includes(d.status)) {
        const track = d.scholar_profile?.scholarship_track || 'Academic Track';
        disbByTrack[track] = (disbByTrack[track] || 0) + Number(d.amount);
      }
    }

    // 7. Intake Conversion Funnel (Coordinator Focus)
    const stageCounts: Record<string, number> = {
      PRE_SCREENING: 0,
      DOCUMENT_VERIFICATION: 0,
      FOR_INTERVIEW: 0,
      INTERVIEW_SCHEDULED: 0,
      ENDORSED_TO_GRANTOR: 0,
      APPROVED: 0,
      REJECTED: 0,
    };

    for (const app of applications) {
      const stage = app.stage?.toUpperCase() || 'PRE_SCREENING';
      if (stageCounts[stage] !== undefined) {
        stageCounts[stage]++;
      } else {
        stageCounts.PRE_SCREENING++;
      }
    }

    const totalApplications = applications.length;
    const preScreeningCount = stageCounts.PRE_SCREENING;
    const endorsedCount = stageCounts.ENDORSED_TO_GRANTOR;
    const approvedCount = stageCounts.APPROVED;

    const intakeFunnel = [
      { stage: 'Pre-Screening', count: totalApplications, pct: 100 },
      {
        stage: 'Document Verification & Interview',
        count:
          stageCounts.DOCUMENT_VERIFICATION +
          stageCounts.FOR_INTERVIEW +
          stageCounts.INTERVIEW_SCHEDULED +
          endorsedCount +
          approvedCount,
        pct:
          totalApplications > 0
            ? Number(
                (
                  ((stageCounts.DOCUMENT_VERIFICATION +
                    stageCounts.FOR_INTERVIEW +
                    stageCounts.INTERVIEW_SCHEDULED +
                    endorsedCount +
                    approvedCount) /
                    totalApplications) *
                  100
                ).toFixed(1),
              )
            : 0,
      },
      {
        stage: 'Endorsed to Grantor',
        count: endorsedCount + approvedCount,
        pct:
          totalApplications > 0
            ? Number((((endorsedCount + approvedCount) / totalApplications) * 100).toFixed(1))
            : 0,
      },
      {
        stage: 'Final Admission / Approved',
        count: approvedCount,
        pct:
          totalApplications > 0
            ? Number(((approvedCount / totalApplications) * 100).toFixed(1))
            : 0,
      },
    ];

    return {
      globalThresholdPercent: gradeThreshold,
      overallStats,
      scholars: scholarsWithPercentile,
      courseBreakdown,
      trackBreakdown,
      schoolBreakdown,
      documentCompliance: {
        totalDocs,
        verifiedDocs,
        pendingDocs,
        rejectedDocs,
        complianceRate: docComplianceRate,
      },
      financialAnalytics: {
        totalDisbursedSum,
        pendingDisbursedSum,
        totalDisbursementsCount: disbursements.length,
        totalOrSubmitted,
        claimedOrReleasedCount,
        orComplianceRate,
        disbByTrack: Object.entries(disbByTrack).map(([track, amount]) => ({
          track,
          amount,
        })),
      },
      intakeFunnel,
    };
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
Your role is to explain scholarship data and charts to program coordinators and grantors in clear, simple, everyday English that anyone can easily understand.

Chart or Metric: ${dto.title || dto.chartType}
Category / Group: ${dto.category || 'All Scholars'}
Metrics & Data: ${JSON.stringify(dto.metrics, null, 2)}
${dto.dataPoints ? `Sample Data Points: ${JSON.stringify(dto.dataPoints.slice(0, 10), null, 2)}` : ''}

CRITICAL GUIDELINES:
1. Speak in friendly, plain English. Do NOT use mathematical or statistical jargon like "standard deviation", "variance", "dispersion", "skewness", "interquartile range", or Greek symbols like σ or μ.
2. Instead of "standard deviation", describe "grade consistency" — whether student grades are close together and consistent or widely spread out.
3. Instead of "retention compliance rate", say "how many scholars meet the required passing grade".
4. Focus on practical insights: how the group is performing, whether anyone needs tutoring or academic support, and helpful next steps for the scholarship team.

Return ONLY a JSON object with this exact structure (no markdown formatting, no code blocks):
{
  "summary": "2-3 short, clear sentences summarizing what this data shows in simple terms.",
  "statisticalInterpretation": "A simple paragraph explaining what the numbers mean in daily practice (grade consistency, passing rates, notable trends) without any mathematical jargon.",
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
            const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            return parsed;
          }
        }
      } catch (err) {
        this.logger.warn(`Gemini API explanation failed, falling back to heuristic explanation: ${err}`);
      }
    }

    // Heuristic Fallback (plain language, non-technical)
    return this.generateStatisticalHeuristicExplanation(dto);
  }

  /**
   * Plain-language heuristic engine when offline or no API key configured.
   */
  private generateStatisticalHeuristicExplanation(dto: ExplainChartDto) {
    if (dto.chartType === 'INTAKE_FUNNEL') {
      const funnel = (dto.metrics?.funnel as Array<{ stage: string; count: number; pct: number }>) || [];
      const total = funnel[0]?.count || 0;
      const approved = funnel[funnel.length - 1]?.count || 0;
      return {
        summary: `The application pipeline currently has ${total} total submissions, with ${approved} applicants reaching final admission.`,
        statisticalInterpretation: `Applicants progress through document verification, interviews, and grantor endorsement. Tracking this pipeline helps identify where applicants may be waiting for reviews or scheduling.`,
        recommendations: [
          'Review applicants currently in document verification to keep the admission process moving promptly.',
          'Coordinate interview schedules with shortlisted candidates to avoid delays before endorsement.',
        ],
        keyHighlights: [
          `Total Applications: ${total}`,
          `Admitted Scholars: ${approved}`,
          `Overall Admission Rate: ${total > 0 ? ((approved / total) * 100).toFixed(1) : 0}%`,
        ],
      };
    }

    if (dto.chartType === 'FINANCIAL_ALLOCATION') {
      const total = Number(dto.metrics?.totalDisbursed || 0);
      const disbByTrack = (dto.metrics?.disbByTrack as Array<{ track: string; amount: number }>) || [];
      const topTrack =
        disbByTrack.length > 0
          ? disbByTrack.reduce((prev, curr) => (curr.amount > prev.amount ? curr : prev), disbByTrack[0])
          : null;
      return {
        summary: `A total of ₱${total.toLocaleString()} in scholarship grants has been released across active program tracks.`,
        statisticalInterpretation: topTrack
          ? `The largest portion of funds (₱${topTrack.amount.toLocaleString()}) was allocated to ${topTrack.track}. Monitoring fund distribution ensures each track receives appropriate financial backing in line with program goals.`
          : `Disbursement tracking provides visibility into how scholarship allowances are distributed across various student groups.`,
        recommendations: [
          'Verify that all scholars have confirmed receipt of their allowances.',
          'Plan upcoming semester budgets based on current track distribution patterns.',
        ],
        keyHighlights: [
          `Total Funds Released: ₱${total.toLocaleString()}`,
          ...(topTrack ? [`Top Funding Track: ${topTrack.track} (₱${topTrack.amount.toLocaleString()})`] : []),
        ],
      };
    }

    const m = dto.metrics || {};
    const mean = Number(m.mean || 0);
    const sd = Number(m.standardDeviation || m.sd || 0);
    const count = Number(m.count || m.totalScholars || 0);
    const complianceRate = Number(m.complianceRate || 0);
    const categoryName = dto.category || dto.title || 'Overall Cohort';

    let consistencyDescription = 'grades are generally consistent';
    if (sd <= 0.25) {
      consistencyDescription = 'grades are very consistent and close together, showing steady academic performance across the group';
    } else if (sd <= 0.5) {
      consistencyDescription = 'grades are moderately balanced, with most scholars performing around the same level';
    } else {
      consistencyDescription = 'grades show noticeable spread, meaning some scholars are excelling while others may be struggling';
    }

    let passingDescription = `${complianceRate}% of scholars meet the required passing grade`;
    if (complianceRate >= 90) {
      passingDescription += ' (Strong standing)';
    } else if (complianceRate >= 75) {
      passingDescription += ' (Good standing, with a few scholars needing attention)';
    } else {
      passingDescription += ' (Attention needed — several scholars are below the required threshold)';
    }

    const highlights: string[] = [
      `Scholars: ${count} in ${categoryName}`,
      `Average Grade: ${mean.toFixed(2)}`,
      `Passing Rate: ${complianceRate}% meeting requirements`,
      `Consistency: ${sd <= 0.25 ? 'High' : sd <= 0.5 ? 'Moderate' : 'Wide Spread'}`,
    ];

    const recommendations: string[] = [];
    if (complianceRate < 85) {
      recommendations.push(
        'Check in with scholars whose grades are below the passing threshold and offer peer tutoring or academic advising.',
      );
    }
    if (sd > 0.4) {
      recommendations.push(
        'Look into courses with higher difficulty where some scholars may need extra study resources.',
      );
    }
    if (recommendations.length === 0) {
      recommendations.push(
        'Continue current academic support as the group maintains strong, reliable performance.',
      );
      recommendations.push(
        'Acknowledge scholars in good standing for their consistent performance.',
      );
    }

    return {
      summary: `For ${categoryName}, scholars have an average grade of ${mean.toFixed(2)} across ${count} students, with ${passingDescription}.`,
      statisticalInterpretation: `Looking at grade distribution, ${consistencyDescription}. The majority of scholars are keeping up with academic expectations, while students below the passing mark can benefit from proactive guidance.`,
      recommendations,
      keyHighlights: highlights,
    };
  }
}
