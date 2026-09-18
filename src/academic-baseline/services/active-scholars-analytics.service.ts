import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class ActiveScholarsAnalyticsService {
  private readonly logger = new Logger(ActiveScholarsAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Coordinator: Get all active scholars with real-time academic standing & financial summary
  async getCoordinatorActiveScholars() {
    const scholars = await this.prisma.scholarProfile.findMany({
      where: {
        OR: [
          { user: { role: 'SCHOLAR' } },
          { applications: { some: { status: 'APPROVED' } } },
          { contracts: { some: { status: 'SIGNED' } } },
          {
            academic_baseline_status: {
              in: [
                'BASELINE_FROZEN',
                'PENDING_COORDINATOR_REVIEW',
                'PENDING_HISTORICAL_CCG',
                'PENDING_PROSPECTUS',
              ],
            },
          },
        ],
        user: { is_active: true },
      },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            role: true,
            is_active: true,
          },
        },
        school_grading_system: true,
        grade_reports: {
          orderBy: { submitted_at: 'desc' },
          include: { grade_items: true },
        },
        disbursements: {
          orderBy: { disbursement_id: 'desc' },
        },
        contracts: {
          orderBy: { contract_id: 'desc' },
        },
        documents: {
          select: {
            document_id: true,
            document_type: true,
            status: true,
            label: true,
          },
        },
        prospectus: {
          include: {
            subjects: {
              where: { status: { in: ['CREDITED', 'PASSED', 'FAILED'] } },
              select: {
                status: true,
                grade: true,
                units: true,
                subject_code: true,
                year_level: true,
                semester: true,
              },
            },
          },
        },
      },
      orderBy: { profile_id: 'desc' },
    });

    return scholars.map((scholar) => {
      const name =
        `${scholar.first_name || ''} ${scholar.last_name || ''}`.trim() ||
        scholar.user.email.split('@')[0];
      const initials =
        `${scholar.first_name?.[0] || ''}${scholar.last_name?.[0] || ''}`.toUpperCase() ||
        'SC';
      const course = scholar.course_of_study || 'General Track';
      const school =
        scholar.school_name ||
        scholar.school_grading_system?.school_name ||
        'Unassigned Institution';

      // 1. GWA calculation from Grade Reports or Prospectus
      const gradeReports = scholar.grade_reports || [];
      let gwa = 0;
      let trend: 'up' | 'down' = 'up';

      if (gradeReports.length > 0) {
        const latest = gradeReports[0];
        gwa = Number(latest.gpa);
        if (gradeReports.length > 1) {
          const prev = gradeReports[1];
          if (
            scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT'
          ) {
            trend = Number(latest.gpa) <= Number(prev.gpa) ? 'up' : 'down';
          } else {
            trend = Number(latest.gpa) >= Number(prev.gpa) ? 'up' : 'down';
          }
        }
      } else if (
        scholar.prospectus?.subjects &&
        scholar.prospectus.subjects.length > 0
      ) {
        const graded = scholar.prospectus.subjects.filter(
          (s) => s.grade != null && !isNaN(Number(s.grade)),
        );
        if (graded.length > 0) {
          const totalWeighted = graded.reduce(
            (acc, s) => acc + Number(s.grade) * (Number(s.units) || 3),
            0,
          );
          const totalUnits = graded.reduce(
            (acc, s) => acc + (Number(s.units) || 3),
            0,
          );
          gwa =
            totalUnits > 0
              ? Number((totalWeighted / totalUnits).toFixed(2))
              : Number(graded[0].grade);
        } else {
          gwa = scholar.school_grading_system?.highest_grade
            ? Number(scholar.school_grading_system.highest_grade)
            : 90.0;
        }
      } else {
        gwa = 90.0;
      }

      // 2. Documents status
      const docs = scholar.documents || [];
      const verifiedDocs = docs.filter((d) => d.status === 'VERIFIED').length;
      const docsText =
        docs.length > 0
          ? `${verifiedDocs}/${docs.length} Verified`
          : scholar.academic_baseline_status === 'BASELINE_FROZEN'
            ? 'Verified'
            : 'Pending Docs';

      // 3. Disbursement status
      const disbursements = scholar.disbursements || [];
      const latestDisb = disbursements[0];
      let disbText = 'None';
      if (latestDisb) {
        const amountStr = `₱${Number(latestDisb.amount).toLocaleString()}`;
        const statusLabel =
          latestDisb.status === 'SETTLED'
            ? 'Settled'
            : latestDisb.status === 'CLAIMED' || latestDisb.status === 'RELEASED'
              ? 'Paid'
              : latestDisb.status === 'CANCELLED'
                ? 'On hold'
                : 'Pending';
        disbText = `${amountStr} ${statusLabel}`;
      }

      // 4. Health determination
      let health: 'good' | 'warn' | 'bad' = 'good';
      const hasFailedReport = gradeReports.some(
        (gr) =>
          gr.status === 'FLAGGED' ||
          gr.status === 'REJECTED' ||
          gr.evaluation_flag === 'ACADEMIC_FAILURE',
      );
      const hasFailedSubject = scholar.prospectus?.subjects?.some(
        (s) => s.status === 'FAILED',
      );
      const hasMissingDocs = docs.some(
        (d) => d.status === 'NEEDS_REUPLOAD' || d.status === 'REJECTED',
      );

      if (hasFailedReport || hasFailedSubject) {
        health = 'bad';
      } else if (hasMissingDocs || verifiedDocs < docs.length) {
        health = 'warn';
      }

      // 5. Current payment
      const currentPayment = latestDisb
        ? {
            term: `${latestDisb.academic_year} ${latestDisb.semester}`,
            amount: Number(latestDisb.amount),
            status:
              latestDisb.status === 'SETTLED'
                ? ('Settled' as const)
                : latestDisb.status === 'CLAIMED' ||
                    latestDisb.status === 'RELEASED'
                  ? ('Paid' as const)
                  : latestDisb.status === 'CANCELLED'
                    ? ('On hold' as const)
                    : ('Pending' as const),
          }
        : {
            term: 'Current Term',
            amount: 0,
            status: 'Pending' as const,
          };

      // 6. Payment history
      const paymentHistory = disbursements.map((d) => ({
        term: `${d.academic_year} ${d.semester}`,
        amount: Number(d.amount),
        date: d.date_claimed
          ? new Date(d.date_claimed).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : d.date_issued
            ? new Date(d.date_issued).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'Pending',
        status:
          d.status === 'SETTLED'
            ? ('Settled' as const)
            : d.status === 'CLAIMED' || d.status === 'RELEASED'
              ? ('Paid' as const)
              : d.status === 'CANCELLED'
                ? ('On hold' as const)
                : ('Pending' as const),
      }));

      // 7. Grade history
      const gradeHistory = gradeReports.map((gr) => ({
        term: `${gr.academic_year} ${gr.semester}`,
        gwa: Number(gr.gpa),
        status:
          gr.status === 'APPROVED'
            ? 'Passed'
            : gr.status === 'FLAGGED' || gr.status === 'REJECTED'
              ? 'Failed'
              : 'Incomplete',
      }));

      if (gradeHistory.length === 0 && gwa > 0) {
        gradeHistory.push({
          term: 'Baseline Evaluation',
          gwa: Number(gwa.toFixed(2)),
          status: 'Passed',
        });
      }

      return {
        id: scholar.profile_id,
        user_id: scholar.user.user_id,
        name,
        initials,
        course,
        school,
        year_level: scholar.current_year_level || 1,
        gwa: Number(gwa.toFixed(2)),
        trend,
        docs: docsText,
        disbursement: disbText,
        health,
        currentPayment,
        gradeHistory,
        paymentHistory,
      };
    });
  }
}
