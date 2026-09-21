import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { SelectSchoolDto } from '../dto/select-school.dto.js';
import { BatchUpdateSubjectsDto } from '../dto/batch-update-subjects.dto.js';

@Injectable()
export class ScholarBaselineService {
  private readonly logger = new Logger(ScholarBaselineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly settingsService: SettingsService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Get complete baseline onboarding state for current scholar
  async getScholarBaselineState(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        school_grading_system: true,
        prospectus: {
          include: {
            subjects: {
              orderBy: [
                { year_level: 'asc' },
                { semester: 'asc' },
                { subject_code: 'asc' },
              ],
            },
            document: true,
            frozen_by_employee: {
              select: {
                employee_id: true,
                first_name: true,
                last_name: true,
                title: true,
              },
            },
          },
        },
        documents: {
          where: {
            document_type: {
              in: ['PROSPECTUS', 'HISTORICAL_CCG', 'TOR', 'GRADE_SLIP'],
            },
          },
          orderBy: { uploaded_at: 'desc' },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const subjects = scholar.prospectus?.subjects || [];
    let totalUnits = 0;
    let creditedUnits = 0;
    let untakenUnits = 0;
    let creditedCount = 0;
    let untakenCount = 0;

    for (const sub of subjects) {
      const u = Number(sub.units) || 0;
      totalUnits += u;
      if (sub.status === 'CREDITED' || sub.status === 'PASSED') {
        creditedUnits += u;
        creditedCount++;
      } else {
        untakenUnits += u;
        untakenCount++;
      }
    }

    return {
      profile_id: scholar.profile_id,
      student_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
      student_number: scholar.student_number,
      course_of_study: scholar.course_of_study,
      current_year_level: scholar.current_year_level,
      academic_baseline_status: scholar.academic_baseline_status,
      school_grading_system: scholar.school_grading_system,
      prospectus: scholar.prospectus,
      documents: scholar.documents,
      metrics: {
        total_subjects: subjects.length,
        total_units: Number(totalUnits.toFixed(1)),
        credited_subjects: creditedCount,
        credited_units: Number(creditedUnits.toFixed(1)),
        untaken_subjects: untakenCount,
        remaining_units: Number(untakenUnits.toFixed(1)),
        is_baseline_frozen: scholar.prospectus?.is_frozen ?? false,
      },
    };
  }

  // 2. Scholar selects or proposes school grading system
  async selectOrProposeSchool(userId: number, dto: SelectSchoolDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    let targetSchoolId: number;

    if (dto.school_id) {
      const existingSchool = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: dto.school_id },
      });
      if (!existingSchool) {
        throw new NotFoundException(
          `School grading ID ${dto.school_id} not found.`,
        );
      }
      targetSchoolId = existingSchool.school_id;
    } else if (dto.new_school_name) {
      const allSchools = await this.prisma.schoolGradingSystem.findMany();
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .replace(/\([^)]*\)/g, '')
          .replace(/[^a-z0-9]/g, '')
          .trim();
      const targetNormalized = normalize(dto.new_school_name);

      const existing = allSchools.find(
        (s) =>
          s.school_name.toLowerCase() ===
            dto.new_school_name!.trim().toLowerCase() ||
          normalize(s.school_name) === targetNormalized,
      );

      if (existing) {
        targetSchoolId = existing.school_id;
      } else {
        const newSchool = await this.settingsService.createSchoolGrading(
          userId,
          {
            school_name: dto.new_school_name.trim(),
            grading_scale: dto.grading_scale || 'NUMERIC_4_POINT',
            passing_grade: dto.passing_grade ?? 2.0,
            highest_grade: dto.highest_grade ?? 4.0,
            failing_grade: dto.failing_grade ?? 1.0,
            min_grade: dto.min_grade ?? 1.0,
            max_grade: dto.max_grade ?? 4.0,
            special_codes: dto.special_codes,
            notes: dto.notes,
            is_verified: false,
          },
          'SCHOLAR',
        );
        targetSchoolId = newSchool.school_id;
      }
    } else {
      throw new BadRequestException(
        'Either school_id or new_school_name must be provided.',
      );
    }

    const nextStatus =
      scholar.academic_baseline_status === 'PENDING_SCHOOL_SELECTION'
        ? 'PENDING_PROSPECTUS'
        : scholar.academic_baseline_status;

    const updated = await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        school_id: targetSchoolId,
        academic_baseline_status: nextStatus,
      },
      include: {
        school_grading_system: true,
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SCHOOL_SELECTED',
      `Scholar selected school grading system '${updated.school_grading_system?.school_name}' (ID: ${targetSchoolId}).`,
    );

    this.eventsGateway.emitToUser(userId, 'baseline:school_selected', {
      school_id: targetSchoolId,
      school_name: updated.school_grading_system?.school_name,
      academic_baseline_status: updated.academic_baseline_status,
    });

    return {
      message: 'Institution grading configuration confirmed.',
      scholar_profile: updated,
    };
  }

  // 3. Scholar / Staff updates prospectus subjects before freezing
  async updateProspectusSubjects(
    userId: number,
    dto: BatchUpdateSubjectsDto,
    isStaff = false,
  ) {
    let scholarProfileId: number;

    if (isStaff) {
      throw new BadRequestException(
        'Staff should use coordinatorUpdateSubjects endpoint.',
      );
    } else {
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { user_id: userId },
        include: { prospectus: true },
      });
      if (!scholar) throw new NotFoundException('Scholar profile not found.');
      if (scholar.prospectus?.is_frozen) {
        throw new ForbiddenException(
          'Your academic baseline is frozen and cannot be modified.',
        );
      }
      scholarProfileId = scholar.profile_id;
    }

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
    });

    if (!prospectus) {
      throw new NotFoundException(
        'Scholar prospectus record not found. Please upload a prospectus first.',
      );
    }

    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectus.prospectus_id },
      data: {
        course_name: dto.course_name || undefined,
        course_code: dto.course_code || undefined,
        curriculum_year: dto.curriculum_year || undefined,
      },
    });

    for (const sub of dto.subjects) {
      if (sub.subject_id) {
        await this.prisma.prospectusSubject.update({
          where: { subject_id: sub.subject_id },
          data: {
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || undefined,
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      } else {
        await this.prisma.prospectusSubject.create({
          data: {
            prospectus_id: prospectus.prospectus_id,
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || 'UNTAKEN',
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      }
    }

    const updated = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectus.prospectus_id },
      include: {
        subjects: {
          orderBy: [
            { year_level: 'asc' },
            { semester: 'asc' },
            { subject_code: 'asc' },
          ],
        },
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBJECTS_UPDATED',
      `Updated ${dto.subjects.length} subjects on prospectus ID ${prospectus.prospectus_id}.`,
    );

    return {
      message: 'Prospectus subjects saved successfully.',
      prospectus: updated,
    };
  }

  // 4. Scholar submits baseline for coordinator freeze review
  async submitForReview(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { prospectus: { include: { subjects: true } } },
    });

    if (!scholar) throw new NotFoundException('Scholar profile not found.');
    if (!scholar.prospectus) {
      throw new BadRequestException(
        'Please upload your prospectus before submitting for review.',
      );
    }
    if (scholar.prospectus.subjects.length === 0) {
      throw new BadRequestException(
        'No subjects found on prospectus checklist.',
      );
    }

    const updated = await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
    });

    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: scholar.prospectus.prospectus_id },
      data: { status: 'PENDING_REVIEW' },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBMITTED_FOR_REVIEW',
      `Scholar ${scholar.first_name} ${scholar.last_name} submitted academic baseline for coordinator freeze review.`,
    );

    const payload = {
      scholarProfileId: scholar.profile_id,
      studentName: `${scholar.first_name} ${scholar.last_name}`.trim(),
      courseOfStudy: scholar.course_of_study,
      schoolName: scholar.school_name,
      subjectsCount: scholar.prospectus.subjects.length,
      submittedAt: new Date().toISOString(),
    };

    this.eventsGateway.emitToStaff('baseline:submitted_for_review', payload);
    this.eventsGateway.emitToUser(
      userId,
      'baseline:submitted_for_review',
      payload,
    );

    return {
      message: 'Academic baseline submitted for coordinator review.',
      academic_baseline_status: updated.academic_baseline_status,
    };
  }

  // Fast aggregated summary endpoint for Scholar Dashboard
  async getScholarDashboardSummary(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
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
        prospectus: {
          include: {
            subjects: {
              orderBy: [
                { year_level: 'asc' },
                { semester: 'asc' },
                { subject_code: 'asc' },
              ],
            },
            frozen_by_employee: {
              select: {
                first_name: true,
                last_name: true,
                title: true,
              },
            },
          },
        },
        grade_reports: {
          orderBy: { submitted_at: 'desc' },
          take: 5,
          include: {
            grade_items: true,
          },
        },
        enrollments: {
          orderBy: { created_at: 'desc' },
          take: 3,
        },
        disbursements: {
          orderBy: { disbursement_id: 'desc' },
          take: 5,
        },
        documents: {
          orderBy: { uploaded_at: 'desc' },
          take: 5,
        },
        meetings: {
          where: {
            meeting_date: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
          orderBy: { meeting_date: 'asc' },
          take: 3,
          include: {
            employee: {
              select: {
                first_name: true,
                last_name: true,
                title: true,
              },
            },
          },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    // Settings for grade threshold
    const systemSettings = await this.prisma.systemSetting.findFirst();
    const threshold = systemSettings?.grade_threshold
      ? Number(systemSettings.grade_threshold)
      : 90.0;

    // 1. Prospectus & Curriculum Metrics
    const subjects = scholar.prospectus?.subjects || [];
    let totalUnits = Number(scholar.prospectus?.total_units) || 0;
    if (totalUnits === 0 && subjects.length > 0) {
      totalUnits = subjects.reduce(
        (acc, s) => acc + (Number(s.units) || 0),
        0,
      );
    }
    const passedSubjects = subjects.filter(
      (s) => s.status === 'PASSED' || s.status === 'CREDITED',
    );
    const passedUnits = passedSubjects.reduce(
      (acc, s) => acc + (Number(s.units) || 0),
      0,
    );
    const curriculumPercentage =
      totalUnits > 0
        ? Math.min(100, Math.round((passedUnits / totalUnits) * 100))
        : 0;

    // 2. GWA Calculation
    let currentGwa = 0;
    const latestGradeReport = scholar.grade_reports[0] || null;
    if (latestGradeReport) {
      currentGwa = Number(latestGradeReport.gpa);
    } else if (passedSubjects.length > 0) {
      const graded = passedSubjects.filter(
        (s) => s.grade != null && !isNaN(Number(s.grade)),
      );
      if (graded.length > 0) {
        const totalWeighted = graded.reduce(
          (acc, s) => acc + Number(s.grade) * (Number(s.units) || 3),
          0,
        );
        const gradedUnits = graded.reduce(
          (acc, s) => acc + (Number(s.units) || 3),
          0,
        );
        currentGwa =
          gradedUnits > 0
            ? Number((totalWeighted / gradedUnits).toFixed(2))
            : Number(graded[0].grade);
      } else {
        currentGwa = threshold;
      }
    } else {
      currentGwa = threshold;
    }

    // 3. Academic Standing Alert & Flag
    const isOnProbation =
      scholar.academic_baseline_status === 'ON_PROBATION' ||
      scholar.grade_reports.some((gr) => gr.appeal_status === 'APPROVED');
    const hasPendingAppeal =
      latestGradeReport?.appeal_status === 'PENDING_GRANTOR';
    const isAppealDenied = latestGradeReport?.appeal_status === 'DENIED';
    const isFlagged =
      latestGradeReport &&
      (!latestGradeReport.is_eligible || latestGradeReport.status === 'FLAGGED');

    let standingType:
      | 'GOOD_STANDING'
      | 'PROBATION'
      | 'ACTION_REQUIRED'
      | 'PENDING_REVIEW' = 'GOOD_STANDING';
    if (isOnProbation) {
      standingType = 'PROBATION';
    } else if (hasPendingAppeal) {
      standingType = 'PENDING_REVIEW';
    } else if (isFlagged || isAppealDenied) {
      standingType = 'ACTION_REQUIRED';
    }

    // 4. Term Enrollment
    const latestEnrollment = scholar.enrollments[0] || null;

    // 5. Disbursements
    const totalDisbursedAmount = scholar.disbursements
      .filter(
        (d) =>
          d.status === 'CLAIMED' ||
          d.status === 'SETTLED' ||
          d.status === 'RELEASED',
      )
      .reduce((acc, d) => acc + Number(d.amount), 0);
    const pendingOrCount = scholar.disbursements.filter(
      (d) =>
        (d.status === 'CLAIMED' || d.status === 'RELEASED') &&
        !d.or_document_id,
    ).length;

    // 6. Unread Messages & Active Conversation
    const conversation = await this.prisma.conversation.findFirst({
      where: { scholar_user_id: userId },
      include: {
        coordinator: {
          include: {
            employee: {
              select: {
                first_name: true,
                last_name: true,
                title: true,
              },
            },
          },
        },
        messages: {
          orderBy: { sent_at: 'desc' },
          take: 5,
        },
      },
    });

    const unreadMessagesCount = conversation
      ? await this.prisma.message.count({
          where: {
            conversation_id: conversation.conversation_id,
            sender_user_id: { not: userId },
            is_read: false,
          },
        })
      : 0;

    // 7. Pinned Forum Announcements
    const announcements = await this.prisma.forumPost.findMany({
      where: {
        OR: [{ is_pinned: true }, { category: 'ANNOUNCEMENT' }],
      },
      orderBy: { created_at: 'desc' },
      take: 3,
      include: {
        author: {
          select: {
            email: true,
            role: true,
            employee: {
              select: {
                first_name: true,
                last_name: true,
                title: true,
              },
            },
          },
        },
      },
    });

    return {
      profile: {
        profile_id: scholar.profile_id,
        user_id: scholar.user_id,
        first_name: scholar.first_name,
        last_name: scholar.last_name,
        email: scholar.user.email,
        phone_number: scholar.phone_number,
        student_number: scholar.student_number,
        school_name:
          scholar.school_name || scholar.school_grading_system?.school_name,
        course_of_study: scholar.course_of_study,
        current_year_level: scholar.current_year_level || 1,
        academic_baseline_status: scholar.academic_baseline_status,
        avatar_url: scholar.avatar_url,
        banner_url: scholar.banner_url,
      },
      school_grading_system: scholar.school_grading_system,
      academic_standing: {
        standing_type: standingType,
        gwa: Number(currentGwa.toFixed(2)),
        threshold: Number(threshold.toFixed(2)),
        is_on_probation: isOnProbation,
        is_flagged: Boolean(isFlagged),
        has_pending_appeal: Boolean(hasPendingAppeal),
        latest_report: latestGradeReport
          ? {
              report_id: latestGradeReport.report_id,
              academic_year: latestGradeReport.academic_year,
              semester: latestGradeReport.semester,
              gpa: Number(latestGradeReport.gpa),
              status: latestGradeReport.status,
              evaluation_flag: latestGradeReport.evaluation_flag,
              appeal_status: latestGradeReport.appeal_status,
              appeal_notes: latestGradeReport.appeal_notes,
              appeal_decision_notes: latestGradeReport.appeal_decision_notes,
            }
          : null,
      },
      curriculum: {
        total_units: Number(totalUnits.toFixed(1)),
        passed_units: Number(passedUnits.toFixed(1)),
        percentage: curriculumPercentage,
        total_subjects: subjects.length,
        passed_subjects_count: passedSubjects.length,
        is_frozen: scholar.prospectus?.is_frozen || false,
        prospectus_status: scholar.prospectus?.status || 'DRAFT',
      },
      latest_enrollment: latestEnrollment
        ? {
            enrollment_id: latestEnrollment.enrollment_id,
            academic_year: latestEnrollment.academic_year,
            semester: latestEnrollment.semester,
            year_level: latestEnrollment.year_level,
            status: latestEnrollment.status,
            total_units: Number(latestEnrollment.total_units),
            total_assessment: Number(latestEnrollment.total_assessment),
            enrolled_subjects: latestEnrollment.enrolled_subjects,
            audit_flags: latestEnrollment.audit_flags,
            cor_document_id: latestEnrollment.cor_document_id,
            soa_document_id: latestEnrollment.soa_document_id,
            coordinator_notes: latestEnrollment.coordinator_notes,
            created_at: latestEnrollment.created_at,
          }
        : null,
      disbursements: {
        latest: scholar.disbursements[0]
          ? {
              disbursement_id: scholar.disbursements[0].disbursement_id,
              academic_year: scholar.disbursements[0].academic_year,
              semester: scholar.disbursements[0].semester,
              amount: Number(scholar.disbursements[0].amount),
              status: scholar.disbursements[0].status,
              date_issued: scholar.disbursements[0].date_issued,
              date_claimed: scholar.disbursements[0].date_claimed,
              voucher_number: scholar.disbursements[0].voucher_number,
              check_number: scholar.disbursements[0].check_number,
              or_number: scholar.disbursements[0].or_number,
              or_document_id: scholar.disbursements[0].or_document_id,
            }
          : null,
        history: scholar.disbursements.map((d) => ({
          disbursement_id: d.disbursement_id,
          academic_year: d.academic_year,
          semester: d.semester,
          amount: Number(d.amount),
          status: d.status,
          date_claimed: d.date_claimed,
          date_issued: d.date_issued,
          or_document_id: d.or_document_id,
        })),
        total_disbursed_amount: totalDisbursedAmount,
        pending_or_count: pendingOrCount,
      },
      communication: {
        unread_messages_count: unreadMessagesCount,
        coordinator: conversation?.coordinator?.employee
          ? {
              name: `${conversation.coordinator.employee.first_name} ${conversation.coordinator.employee.last_name}`.trim(),
              title:
                conversation.coordinator.employee.title ||
                'Scholarship Coordinator',
            }
          : null,
        recent_messages: (conversation?.messages || []).map((m) => ({
          message_id: m.message_id,
          sender_user_id: m.sender_user_id,
          message_text: m.message_text,
          message_type: m.message_type,
          sent_at: m.sent_at,
          is_read: m.is_read,
        })),
      },
      upcoming_meetings: scholar.meetings.map((m) => ({
        meeting_id: m.meeting_id,
        title: m.title,
        meeting_date: m.meeting_date,
        meeting_time: m.meeting_time,
        meeting_link: m.meeting_link,
        status: m.status,
        coordinator_name: m.employee
          ? `${m.employee.first_name} ${m.employee.last_name}`
          : 'Coordinator',
      })),
      announcements: announcements.map((a) => ({
        post_id: a.post_id,
        title: a.title,
        content: a.content,
        category: a.category,
        is_pinned: a.is_pinned,
        created_at: a.created_at,
        author_name: a.author.employee
          ? `${a.author.employee.first_name} ${a.author.employee.last_name}`
          : 'ViaScholar Staff',
      })),
    };
  }
}
