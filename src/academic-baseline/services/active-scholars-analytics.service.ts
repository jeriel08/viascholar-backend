import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class ActiveScholarsAnalyticsService {
  private readonly logger = new Logger(ActiveScholarsAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Coordinator: Get all active scholars with real-time academic standing & financial summary
  async getCoordinatorActiveScholars() {
    const scholars = await this.prisma.scholarProfile.findMany({
      where: {
        archived_at: null,
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
            : latestDisb.status === 'CLAIMED' ||
                latestDisb.status === 'RELEASED'
              ? 'Paid'
              : latestDisb.status === 'CANCELLED'
                ? 'On hold'
                : 'Pending';
        disbText = `${amountStr} ${statusLabel}`;
      }

      // 4. Health determination
      let health: 'good' | 'warn' | 'bad' = 'good';

      const isOnProbation =
        scholar.academic_baseline_status === 'ON_PROBATION' ||
        gradeReports.some((gr) => gr.appeal_status === 'APPROVED');

      const hasActiveUnresolvedFailure = gradeReports.some(
        (gr) =>
          (gr.status === 'FLAGGED' ||
            gr.status === 'REJECTED' ||
            gr.evaluation_flag === 'ACADEMIC_FAILURE') &&
          gr.appeal_status !== 'APPROVED',
      );
      const hasFailedSubject = scholar.prospectus?.subjects?.some(
        (s) => s.status === 'FAILED',
      );
      const hasMissingDocs = docs.some(
        (d) => d.status === 'NEEDS_REUPLOAD' || d.status === 'REJECTED',
      );

      if (isOnProbation) {
        health = 'warn';
      } else if (
        hasActiveUnresolvedFailure ||
        (hasFailedSubject && !isOnProbation)
      ) {
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

  /**
   * Returns a comprehensive single-scholar dossier for Coordinator and Grantor
   * full-details pages: profile, grading system, prospectus + subjects,
   * uploaded documents, disbursements, grade reports, term enrollments, and contracts.
   */
  async getCoordinatorScholarDetails(scholarProfileId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: scholarProfileId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            role: true,
            is_active: true,
            is_email_verified: true,
            public_profile: true,
            created_at: true,
          },
        },
        school_grading_system: {
          select: {
            school_id: true,
            school_name: true,
            grading_scale: true,
            passing_grade: true,
            highest_grade: true,
            failing_grade: true,
            is_verified: true,
          },
        },
        prospectus: {
          include: {
            document: {
              select: {
                document_id: true,
                document_type: true,
                label: true,
                file_name: true,
                file_url: true,
                file_size: true,
                file_type: true,
                status: true,
                uploaded_at: true,
              },
            },
            frozen_by_employee: {
              select: {
                employee_id: true,
                first_name: true,
                last_name: true,
                title: true,
              },
            },
            subjects: {
              orderBy: [
                { year_level: 'asc' },
                { semester: 'asc' },
                { subject_code: 'asc' },
              ],
            },
          },
        },
        documents: {
          orderBy: { uploaded_at: 'desc' },
          include: {
            reviewed_by_employee: {
              select: {
                employee_id: true,
                first_name: true,
                last_name: true,
              },
            },
          },
        },
        disbursements: {
          orderBy: { disbursement_id: 'desc' },
          include: {
            or_document: {
              select: {
                document_id: true,
                file_url: true,
                file_name: true,
                file_type: true,
                status: true,
              },
            },
            approved_by_employee: {
              select: {
                employee_id: true,
                first_name: true,
                last_name: true,
              },
            },
            settled_by_employee: {
              select: {
                employee_id: true,
                first_name: true,
                last_name: true,
              },
            },
            term_enrollment: {
              select: {
                enrollment_id: true,
                academic_year: true,
                semester: true,
                year_level: true,
                total_units: true,
                total_assessment: true,
                status: true,
                cor_document: {
                  select: {
                    document_id: true,
                    file_url: true,
                    file_name: true,
                  },
                },
                soa_document: {
                  select: {
                    document_id: true,
                    file_url: true,
                    file_name: true,
                  },
                },
              },
            },
          },
        },
        grade_reports: {
          orderBy: { submitted_at: 'desc' },
          include: {
            grade_items: true,
            document: {
              select: {
                document_id: true,
                file_url: true,
                file_name: true,
                status: true,
              },
            },
          },
        },
        enrollments: {
          orderBy: { enrollment_id: 'desc' },
          include: {
            cor_document: {
              select: {
                document_id: true,
                file_url: true,
                file_name: true,
                status: true,
              },
            },
            soa_document: {
              select: {
                document_id: true,
                file_url: true,
                file_name: true,
                status: true,
              },
            },
          },
        },
        contracts: {
          orderBy: { contract_id: 'desc' },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException(
        `Scholar profile ${scholarProfileId} not found.`,
      );
    }

    const subjects = scholar.prospectus?.subjects ?? [];
    const totalUnits = subjects.reduce(
      (sum, s) => sum + Number(s.units || 0),
      0,
    );
    const creditedUnits = subjects
      .filter((s) => s.status === 'PASSED' || s.status === 'CREDITED')
      .reduce((sum, s) => sum + Number(s.units || 0), 0);
    const enrolledUnits = subjects
      .filter((s) => s.status === 'ENROLLED')
      .reduce((sum, s) => sum + Number(s.units || 0), 0);

    // Weighted GWA across graded subjects, falling back to latest approved grade report GPA.
    let weightedSum = 0;
    let gradedUnits = 0;
    for (const s of subjects) {
      if (s.grade != null && Number(s.units || 0) > 0) {
        const numericGrade = Number(s.grade);
        if (Number.isFinite(numericGrade)) {
          weightedSum += numericGrade * Number(s.units);
          gradedUnits += Number(s.units);
        }
      }
    }

    let gwa: number | null =
      gradedUnits > 0 ? Number((weightedSum / gradedUnits).toFixed(2)) : null;
    if (gwa === null && scholar.grade_reports.length > 0) {
      const latestReportWithGpa = scholar.grade_reports.find(
        (r) => r.gpa != null && Number.isFinite(Number(r.gpa)),
      );
      if (latestReportWithGpa) {
        gwa = Number(Number(latestReportWithGpa.gpa).toFixed(2));
      }
    }

    const hasFailedSubject = subjects.some((s) => s.status === 'FAILED');
    const hasAcademicFailure = scholar.grade_reports.some(
      (r) => r.evaluation_flag === 'ACADEMIC_FAILURE',
    );
    const hasDocumentIssue = scholar.documents.some(
      (d) =>
        d.status === 'NEEDS_REUPLOAD' ||
        d.status === 'REJECTED' ||
        d.status === 'PENDING' ||
        d.status === 'PASSED_PRECHECK' ||
        d.status === 'STUDENT_CONFIRMED',
    );
    const hasGradeWarning = scholar.grade_reports.some(
      (r) => r.evaluation_flag === 'BELOW_PASSING_MARK',
    );

    let health: 'good' | 'warn' | 'bad' = 'good';
    if (hasFailedSubject || hasAcademicFailure) {
      health = 'bad';
    } else if (
      hasDocumentIssue ||
      hasGradeWarning ||
      scholar.academic_baseline_status !== 'BASELINE_FROZEN'
    ) {
      health = 'warn';
    }

    const totalDisbursedAmount = scholar.disbursements
      .filter((d) =>
        ['SETTLED', 'CLAIMED', 'RELEASED', 'APPROVED'].includes(d.status),
      )
      .reduce((sum, d) => sum + Number(d.amount || 0), 0);
    const settledDisbursedAmount = scholar.disbursements
      .filter((d) => d.status === 'SETTLED' || d.status === 'CLAIMED')
      .reduce((sum, d) => sum + Number(d.amount || 0), 0);

    return {
      scholar_profile: {
        profile_id: scholar.profile_id,
        user_id: scholar.user_id,
        first_name: scholar.first_name,
        middle_name: scholar.middle_name,
        last_name: scholar.last_name,
        suffix: scholar.suffix,
        sex: scholar.sex,
        email: scholar.user.email,
        role: scholar.user.role,
        is_active: scholar.user.is_active,
        is_email_verified: scholar.user.is_email_verified,
        public_profile: scholar.user.public_profile,
        phone_number: scholar.phone_number,
        is_phone_verified: scholar.is_phone_verified,
        student_address: scholar.student_address,
        school_address: scholar.school_address,
        student_number: scholar.student_number,
        scholarship_track: scholar.scholarship_track,
        course_of_study: scholar.course_of_study,
        school_name:
          scholar.school_grading_system?.school_name ?? scholar.school_name,
        academic_baseline_status: scholar.academic_baseline_status,
        current_year_level: scholar.current_year_level,
        bio: scholar.bio,
        avatar_url: scholar.avatar_url,
        banner_url: scholar.banner_url,
        archived_at: scholar.archived_at,
        created_at: scholar.user.created_at,
      },
      school_grading_system: scholar.school_grading_system
        ? {
            ...scholar.school_grading_system,
            passing_grade: Number(scholar.school_grading_system.passing_grade),
            highest_grade: Number(scholar.school_grading_system.highest_grade),
            failing_grade: Number(scholar.school_grading_system.failing_grade),
          }
        : null,
      prospectus: scholar.prospectus
        ? {
            ...scholar.prospectus,
            total_units:
              scholar.prospectus.total_units != null
                ? Number(scholar.prospectus.total_units)
                : null,
            subjects: subjects.map((s) => ({
              ...s,
              units: Number(s.units),
              grade: s.grade != null ? Number(s.grade) : null,
            })),
          }
        : null,
      documents: scholar.documents,
      disbursements: scholar.disbursements.map((d) => ({
        ...d,
        amount: Number(d.amount),
        term_enrollment: d.term_enrollment
          ? {
              ...d.term_enrollment,
              total_units: Number(d.term_enrollment.total_units),
              total_assessment: Number(d.term_enrollment.total_assessment),
            }
          : null,
      })),
      grade_reports: scholar.grade_reports.map((r) => ({
        ...r,
        gpa: Number(r.gpa),
        grade_items: r.grade_items.map((gi) => ({
          ...gi,
          units: Number(gi.units),
        })),
      })),
      term_enrollments: scholar.enrollments.map((e) => ({
        ...e,
        total_units: Number(e.total_units),
        total_assessment: Number(e.total_assessment),
      })),
      contracts: scholar.contracts,
      metrics: {
        gwa,
        health,
        total_subjects: subjects.length,
        total_units: Number(totalUnits.toFixed(1)),
        credited_units: Number(creditedUnits.toFixed(1)),
        enrolled_units: Number(enrolledUnits.toFixed(1)),
        remaining_units: Number(
          Math.max(0, totalUnits - creditedUnits).toFixed(1),
        ),
        total_documents: scholar.documents.length,
        verified_documents: scholar.documents.filter(
          (d) => d.status === 'VERIFIED',
        ).length,
        pending_documents: scholar.documents.filter(
          (d) =>
            d.status === 'PENDING' ||
            d.status === 'PASSED_PRECHECK' ||
            d.status === 'STUDENT_CONFIRMED',
        ).length,
        total_disbursements: scholar.disbursements.length,
        total_disbursed_amount: Number(totalDisbursedAmount.toFixed(2)),
        settled_disbursed_amount: Number(settledDisbursedAmount.toFixed(2)),
      },
    };
  }
}
