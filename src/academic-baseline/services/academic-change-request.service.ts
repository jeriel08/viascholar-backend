import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { MailService } from '../../mail/mail.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import {
  normalizeAcademicYear,
  normalizeSemester,
} from '../../documents/utils/academic-term.util.js';
import {
  type AcademicChangeType,
  CreateAcademicChangeRequestDto,
  ReviewAcademicChangeRequestDto,
} from '../dto/academic-change-request.dto.js';
import { archiveProspectusToHistory } from '../utils/shift-prospectus.util.js';

export interface AcademicChangeEligibility {
  allowed: boolean;
  reason: string | null;
  ongoing_term: {
    enrollment_id: number;
    academic_year: string;
    semester: string;
    status: string;
  } | null;
}

const CHANGE_TYPE_LABELS: Record<AcademicChangeType, string> = {
  PROGRAM_SHIFT: 'Program Shift',
  SCHOOL_TRANSFER: 'School Transfer',
  BOTH: 'Program Shift & School Transfer',
};

function normalizeLabel(value?: string | null): string {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatEffectiveTerm(ay?: string | null, sem?: string | null): string | null {
  const parts = [ay ? `A.Y. ${ay.trim()}` : null, sem?.trim() || null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

@Injectable()
export class AcademicChangeRequestService {
  private readonly logger = new Logger(AcademicChangeRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly eventsGateway: EventsGateway,
    private readonly cacheService: AppCacheService,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private readonly requestInclude = {
    scholar_profile: {
      select: {
        profile_id: true,
        user_id: true,
        first_name: true,
        middle_name: true,
        last_name: true,
        student_number: true,
        course_of_study: true,
        school_name: true,
        school_id: true,
        current_year_level: true,
        academic_baseline_status: true,
        user: { select: { email: true } },
        prospectus: {
          select: {
            prospectus_id: true,
            course_name: true,
            course_code: true,
            is_frozen: true,
            status: true,
          },
        },
      },
    },
    requested_program: {
      select: {
        program_id: true,
        program_code: true,
        program_name: true,
        category: true,
      },
    },
    supporting_document: {
      select: {
        document_id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        uploaded_at: true,
      },
    },
    reviewed_by: {
      select: {
        user_id: true,
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
  } as const;

  private async resolveProgramTarget(dto: CreateAcademicChangeRequestDto) {
    if (dto.requested_program_id) {
      const program = await this.prisma.academicProgram.findUnique({
        where: { program_id: dto.requested_program_id },
      });
      if (!program || !program.is_active) {
        throw new BadRequestException('Selected academic program is not available.');
      }
      return {
        programId: program.program_id,
        courseName: program.program_name,
        courseCode: program.program_code,
      };
    }

    const customCourse = dto.requested_course_of_study?.trim();
    if (!customCourse) {
      throw new BadRequestException('Please select or enter the target degree program.');
    }

    return {
      programId: null,
      courseName: customCourse,
      courseCode: null,
    };
  }

  private async resolveSchoolTarget(dto: CreateAcademicChangeRequestDto) {
    if (dto.requested_school_id) {
      const school = await this.prisma.school.findUnique({
        where: { school_id: dto.requested_school_id },
      });
      if (school) {
        return {
          schoolId: school.school_id,
          schoolName: school.school_name,
        };
      }

      const gradingSchool = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: dto.requested_school_id },
      });
      if (!gradingSchool) {
        throw new BadRequestException('Selected target school was not found.');
      }
      return {
        schoolId: gradingSchool.school_id,
        schoolName: gradingSchool.school_name,
      };
    }

    const customSchool = dto.requested_school_name?.trim();
    if (!customSchool) {
      throw new BadRequestException('Please select or enter the target school name.');
    }

    return {
      schoolId: null,
      schoolName: customSchool,
    };
  }

  private async resolveGradingSystemIdForApproval(
    requestedSchoolId: number | null,
    requestedSchoolName: string | null,
  ): Promise<number | null> {
    if (requestedSchoolId) {
      const school = await this.prisma.school.findUnique({
        where: { school_id: requestedSchoolId },
        select: { grading_system_id: true },
      });
      if (school?.grading_system_id) {
        return school.grading_system_id;
      }

      const gradingDirect = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: requestedSchoolId },
        select: { school_id: true },
      });
      if (gradingDirect) {
        return gradingDirect.school_id;
      }
    }

    if (requestedSchoolName) {
      const match = await this.prisma.schoolGradingSystem.findFirst({
        where: {
          school_name: { equals: requestedSchoolName, mode: 'insensitive' },
        },
        select: { school_id: true },
      });
      if (match) {
        return match.school_id;
      }
    }

    return null;
  }

  async evaluateEligibilityForScholar(
    scholarProfileId: number,
    scholarContext?: {
      academic_baseline_status?: string | null;
      prospectus?: { is_frozen?: boolean | null } | null;
    },
  ): Promise<AcademicChangeEligibility> {
    if (typeof (this.prisma as any).academicChangeRequest?.findFirst === 'function') {
      const pendingRequest = await (this.prisma as any).academicChangeRequest.findFirst({
        where: {
          scholar_profile_id: scholarProfileId,
          status: 'PENDING_GRANTOR',
        },
        select: { request_id: true },
      });
      if (pendingRequest) {
        return {
          allowed: false,
          reason:
            'You already have a pending program shift or school transfer request awaiting Grantor confirmation.',
          ongoing_term: null,
        };
      }
    }

    const blockedStatuses = new Set([
      'PENDING_SHIFT_PROSPECTUS',
      'PENDING_COORDINATOR_REVIEW',
      'PENDING_SCHOOL_SELECTION',
      'PENDING_PROSPECTUS',
      'PENDING_HISTORICAL_CCG',
      'DISCONTINUED',
    ]);
    const status = scholarContext?.academic_baseline_status || '';
    const hasUnfrozenProspectus = Boolean(
      scholarContext?.prospectus && scholarContext.prospectus.is_frozen === false,
    );
    if (blockedStatuses.has(status) || hasUnfrozenProspectus) {
      return {
        allowed: false,
        reason:
          'You must complete uploading and verifying your current curriculum prospectus before requesting a program shift or school transfer.',
        ongoing_term: null,
      };
    }

    if (typeof (this.prisma as any).termEnrollment?.findMany !== 'function') {
      return { allowed: true, reason: null, ongoing_term: null };
    }

    const enrollments =
      (await (this.prisma as any).termEnrollment.findMany({
        where: {
          scholar_profile_id: scholarProfileId,
          status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
        },
        orderBy: { created_at: 'desc' },
      })) || [];

    const activeEnrollments = enrollments.filter(
      (enr: any) =>
        enr.status !== 'DRAFT' ||
        enr.cor_document_id != null ||
        enr.soa_document_id != null,
    );

    if (activeEnrollments.length === 0) {
      return { allowed: true, reason: null, ongoing_term: null };
    }

    const gradeReports =
      typeof (this.prisma as any).gradeReport?.findMany === 'function'
        ? (await (this.prisma as any).gradeReport.findMany({
            where: {
              scholar_profile_id: scholarProfileId,
              status: { not: 'REJECTED' },
            },
            select: {
              report_id: true,
              term_enrollment_id: true,
              academic_year: true,
              semester: true,
            },
          })) || []
        : [];

    const confirmedGradeDocs =
      typeof (this.prisma as any).scholarDocument?.findMany === 'function'
        ? (await (this.prisma as any).scholarDocument.findMany({
            where: {
              scholar_profile_id: scholarProfileId,
              document_type: { in: ['CCG', 'GRADE_SLIP', 'GRADE_REPORT'] },
              status: { in: ['STUDENT_CONFIRMED', 'VERIFIED'] },
            },
            select: {
              document_id: true,
              uploaded_at: true,
              confirmed_data: true,
              extracted_data: true,
            },
          })) || []
        : [];

    for (const enr of activeEnrollments) {
      const enrAy = normalizeAcademicYear(enr.academic_year) || enr.academic_year;
      const enrSem = normalizeSemester(enr.semester) || enr.semester;

      const hasReport = gradeReports.some((rep: any) => {
        if (rep.term_enrollment_id && rep.term_enrollment_id === enr.enrollment_id) {
          return true;
        }
        const repAy = normalizeAcademicYear(rep.academic_year) || rep.academic_year;
        const repSem = normalizeSemester(rep.semester) || rep.semester;
        return repAy === enrAy && repSem === enrSem;
      });

      const hasGradeDoc = confirmedGradeDocs.some((doc: any) => {
        const meta = (doc.confirmed_data || doc.extracted_data || {}) as Record<string, any>;
        if (meta.academic_year || meta.semester) {
          const docAy = meta.academic_year
            ? normalizeAcademicYear(String(meta.academic_year)) || String(meta.academic_year).trim()
            : enrAy;
          const docSem = meta.semester
            ? normalizeSemester(String(meta.semester)) || String(meta.semester).trim()
            : enrSem;
          return docAy === enrAy && docSem === enrSem;
        }
        if (doc.uploaded_at && enr.created_at) {
          return new Date(doc.uploaded_at).getTime() >= new Date(enr.created_at).getTime();
        }
        return true;
      });

      if (!hasReport && !hasGradeDoc) {
        return {
          allowed: false,
          reason: `You cannot request a program shift or school transfer while you have an ongoing enrollment (${enr.academic_year} · ${enr.semester}) without submitted grades. Please submit your grades first.`,
          ongoing_term: {
            enrollment_id: enr.enrollment_id,
            academic_year: enr.academic_year,
            semester: enr.semester,
            status: enr.status,
          },
        };
      }
    }

    return { allowed: true, reason: null, ongoing_term: null };
  }

  async getEligibility(userId: number): Promise<AcademicChangeEligibility> {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      select: {
        profile_id: true,
        academic_baseline_status: true,
        prospectus: { select: { is_frozen: true } },
      },
    });
    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }
    return this.evaluateEligibilityForScholar(scholar.profile_id, scholar);
  }

  async getMyRequests(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      select: { profile_id: true },
    });
    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    return this.prisma.academicChangeRequest.findMany({
      where: { scholar_profile_id: scholar.profile_id },
      include: this.requestInclude,
      orderBy: { created_at: 'desc' },
    });
  }

  async createRequest(
    userId: number,
    dto: CreateAcademicChangeRequestDto,
    file?: Express.Multer.File,
  ) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        user: { select: { email: true } },
        school_grading_system: { select: { school_name: true } },
        prospectus: { select: { is_frozen: true } },
      },
    });
    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const eligibility = await this.evaluateEligibilityForScholar(
      scholar.profile_id,
      scholar,
    );
    if (!eligibility.allowed) {
      throw new ForbiddenException(
        eligibility.reason ||
          'You cannot request a program shift or school transfer while you have an ongoing semester without submitted grades.',
      );
    }

    const existingPending = await this.prisma.academicChangeRequest.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        status: 'PENDING_GRANTOR',
      },
    });
    if (existingPending) {
      throw new BadRequestException(
        'You already have a pending program/school change request awaiting Grantor confirmation.',
      );
    }

    const currentSchoolName =
      scholar.school_name?.trim() || scholar.school_grading_system?.school_name || null;
    const currentCourse = scholar.course_of_study?.trim() || null;

    const includesProgram = dto.change_type === 'PROGRAM_SHIFT' || dto.change_type === 'BOTH';
    const includesSchool = dto.change_type === 'SCHOOL_TRANSFER' || dto.change_type === 'BOTH';

    const programTarget = includesProgram ? await this.resolveProgramTarget(dto) : null;
    const schoolTarget = includesSchool ? await this.resolveSchoolTarget(dto) : null;

    if (
      includesProgram &&
      programTarget &&
      currentCourse &&
      normalizeLabel(programTarget.courseName) === normalizeLabel(currentCourse)
    ) {
      throw new BadRequestException(
        'The requested program is the same as your current program of study.',
      );
    }

    if (
      includesSchool &&
      schoolTarget &&
      currentSchoolName &&
      normalizeLabel(schoolTarget.schoolName) === normalizeLabel(currentSchoolName)
    ) {
      throw new BadRequestException('The requested school is the same as your current school.');
    }

    let supportingDocumentId: number | null = null;
    if (file) {
      const uploadResult = await this.cloudinaryService.uploadBuffer(
        file.buffer,
        'viascholar/academic-changes',
        `shift_req_${scholar.profile_id}_${Date.now()}`,
        'auto',
      );
      const doc = await this.prisma.scholarDocument.create({
        data: {
          scholar_profile_id: scholar.profile_id,
          document_type: 'PROGRAM_SHIFT_REQUEST',
          label: `${CHANGE_TYPE_LABELS[dto.change_type]} Supporting Document`,
          file_name: file.originalname,
          file_url: uploadResult.secure_url,
          file_size: `${(file.size / 1024).toFixed(1)} KB`,
          file_type: file.mimetype.split('/')[1] || 'pdf',
          status: 'PENDING',
        },
      });
      supportingDocumentId = doc.document_id;
    }

    const created = await this.prisma.academicChangeRequest.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        change_type: dto.change_type,
        current_course_of_study: currentCourse,
        current_school_id: scholar.school_id,
        current_school_name: currentSchoolName,
        requested_program_id: programTarget?.programId ?? null,
        requested_course_of_study: programTarget?.courseName ?? null,
        requested_school_id: schoolTarget?.schoolId ?? null,
        requested_school_name: schoolTarget?.schoolName ?? null,
        effective_academic_year: dto.effective_academic_year?.trim() || null,
        effective_semester: dto.effective_semester?.trim() || null,
        reason: dto.reason.trim(),
        supporting_document_id: supportingDocumentId,
        status: 'PENDING_GRANTOR',
      },
      include: this.requestInclude,
    });

    const studentName = `${scholar.first_name} ${scholar.last_name}`.trim() || 'Scholar';
    const changeLabel = CHANGE_TYPE_LABELS[dto.change_type];
    const currentSummary = [currentCourse || 'Unassigned Program', currentSchoolName || 'Unassigned School'].join(
      ' · ',
    );
    const requestedSummary = [
      programTarget ? `Program: ${programTarget.courseName}` : null,
      schoolTarget ? `School: ${schoolTarget.schoolName}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    await this.auditService.log(
      userId,
      'ACADEMIC_CHANGE_REQUESTED',
      `Scholar ${studentName} requested ${changeLabel}: ${requestedSummary}`,
    );

    // Notify Grantors (primary decision maker) and CC Coordinators + Admins
    try {
      await Promise.all([
        this.notificationsService.createForRoles([Role.GRANTOR], {
          title: `${changeLabel} Request`,
          message: `${studentName} requested a ${changeLabel.toLowerCase()} (${requestedSummary}). Confirmation required.`,
          category: 'system',
          link: '/grantMonitor?tab=shift-requests',
        }),
        this.notificationsService.createForRoles([Role.COORDINATOR, Role.ADMIN], {
          title: `[CC] ${changeLabel} Request`,
          message: `${studentName} submitted a ${changeLabel.toLowerCase()} request to the Grantor (${requestedSummary}).`,
          category: 'system',
          link: '/CoordinatorMonitor?tab=shift-requests',
        }),
      ]);
    } catch (err) {
      this.logger.warn(`Failed to dispatch academic change in-app notifications: ${err}`);
    }

    try {
      await this.mailService.sendAcademicChangeRequestedEmail({
        studentName,
        changeLabel,
        currentSummary,
        requestedSummary,
        reason: created.reason,
        effectiveTerm: formatEffectiveTerm(created.effective_academic_year, created.effective_semester),
      });
    } catch (err) {
      this.logger.warn(`Failed to send academic change request email: ${err}`);
    }

    const socketPayload = {
      request_id: created.request_id,
      scholar_profile_id: created.scholar_profile_id,
      status: created.status,
      change_type: created.change_type,
    };
    this.eventsGateway.emitToStaff('academic_change:requested', socketPayload);
    this.eventsGateway.emitToUser(scholar.user_id, 'academic_change:requested', socketPayload);

    await this.cacheService.del(`baseline:scholar:${userId}`);

    return created;
  }

  async cancelMyRequest(userId: number, requestId: number) {
    const request = await this.prisma.academicChangeRequest.findUnique({
      where: { request_id: requestId },
      include: { scholar_profile: { select: { user_id: true, profile_id: true } } },
    });

    if (!request) {
      throw new NotFoundException(`Academic change request #${requestId} not found.`);
    }
    if (request.scholar_profile.user_id !== userId) {
      throw new ForbiddenException('You can only cancel your own change requests.');
    }
    if (request.status !== 'PENDING_GRANTOR') {
      throw new BadRequestException('Only pending requests can be cancelled.');
    }

    const updated = await this.prisma.academicChangeRequest.update({
      where: { request_id: requestId },
      data: { status: 'CANCELLED' },
      include: this.requestInclude,
    });

    await this.auditService.log(
      userId,
      'ACADEMIC_CHANGE_CANCELLED',
      `Scholar cancelled academic change request #${requestId}.`,
    );

    const payload = {
      request_id: updated.request_id,
      scholar_profile_id: updated.scholar_profile_id,
      status: updated.status,
    };
    this.eventsGateway.emitToStaff('academic_change:reviewed', payload);
    this.eventsGateway.emitToUser(userId, 'academic_change:reviewed', payload);

    return updated;
  }

  async listRequestsForStaff(status?: string) {
    const requests = await this.prisma.academicChangeRequest.findMany({
      where: status ? { status } : undefined,
      include: this.requestInclude,
      orderBy: [{ created_at: 'desc' }],
    });

    // Place pending requests ahead of historical decisions while keeping reverse-chronological order
    return requests.sort((a, b) => {
      const aPending = a.status === 'PENDING_GRANTOR' ? 0 : 1;
      const bPending = b.status === 'PENDING_GRANTOR' ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      return b.created_at.getTime() - a.created_at.getTime();
    });
  }

  async reviewRequest(
    reviewerUserId: number,
    requestId: number,
    dto: ReviewAcademicChangeRequestDto,
  ) {
    const existing = await this.prisma.academicChangeRequest.findUnique({
      where: { request_id: requestId },
      include: {
        scholar_profile: {
          include: {
            user: { select: { email: true, user_id: true } },
            prospectus: {
              include: {
                subjects: {
                  orderBy: [
                    { year_level: 'asc' },
                    { semester: 'asc' },
                    { subject_code: 'asc' },
                  ],
                },
              },
            },
          },
        },
        requested_program: true,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Academic change request #${requestId} not found.`);
    }
    if (existing.status !== 'PENDING_GRANTOR') {
      throw new BadRequestException(
        `This request has already been finalized (${existing.status}).`,
      );
    }

    const reviewedAt = new Date();
    const notes = dto.decision_notes?.trim() || null;

    if (dto.decision === 'DENIED') {
      const updated = await this.prisma.academicChangeRequest.update({
        where: { request_id: requestId },
        data: {
          status: 'DENIED',
          reviewed_by_user_id: reviewerUserId,
          reviewed_at: reviewedAt,
          decision_notes: notes,
        },
        include: this.requestInclude,
      });

      await this.finalizeReviewEffects(existing, updated, dto.decision, notes);
      return updated;
    }

    const includesProgram =
      existing.change_type === 'PROGRAM_SHIFT' || existing.change_type === 'BOTH';
    const includesSchool =
      existing.change_type === 'SCHOOL_TRANSFER' || existing.change_type === 'BOTH';

    const targetGradingSchoolId = includesSchool
      ? await this.resolveGradingSystemIdForApproval(
          existing.requested_school_id,
          existing.requested_school_name,
        )
      : existing.scholar_profile.school_id;

    const nextBaselineStatus = 'PENDING_SHIFT_PROSPECTUS';

    const updated = await this.prisma.$transaction(async (tx) => {
      const savedRequest = await tx.academicChangeRequest.update({
        where: { request_id: requestId },
        data: {
          status: 'APPROVED',
          reviewed_by_user_id: reviewerUserId,
          reviewed_at: reviewedAt,
          decision_notes: notes,
        },
        include: this.requestInclude,
      });

      await tx.scholarProfile.update({
        where: { profile_id: existing.scholar_profile_id },
        data: {
          ...(includesProgram && existing.requested_course_of_study
            ? { course_of_study: existing.requested_course_of_study }
            : {}),
          ...(includesSchool && existing.requested_school_name
            ? {
                school_name: existing.requested_school_name,
                school_id: targetGradingSchoolId,
              }
            : {}),
          academic_baseline_status: nextBaselineStatus,
        },
      });

      // Preserve the previous program's prospectus & earned grades in history,
      // then clear the active checklist so the scholar uploads a clean new prospectus.
      if (existing.scholar_profile.prospectus) {
        await archiveProspectusToHistory(
          tx,
          existing.scholar_profile.prospectus,
          {
            scholarProfileId: existing.scholar_profile_id,
            academicChangeRequestId: existing.request_id,
            schoolName:
              (existing.scholar_profile as { school_name?: string | null })
                .school_name ?? null,
            archiveReason: existing.change_type || 'PROGRAM_SHIFT',
          },
        );

        if (typeof (tx as any).scholarProspectus?.deleteMany === 'function') {
          await (tx as any).scholarProspectus.deleteMany({
            where: { scholar_profile_id: existing.scholar_profile_id },
          });
        } else if (typeof (tx as any).scholarProspectus?.delete === 'function') {
          await (tx as any).scholarProspectus.delete({
            where: { prospectus_id: existing.scholar_profile.prospectus.prospectus_id },
          });
        }
      }

      return savedRequest;
    });

    await this.finalizeReviewEffects(existing, updated, 'APPROVED', notes);
    return updated;
  }

  private async finalizeReviewEffects(
    existing: {
      request_id: number;
      scholar_profile_id: number;
      change_type: string;
      requested_course_of_study: string | null;
      requested_school_name: string | null;
      scholar_profile: {
        user_id: number;
        first_name: string;
        last_name: string;
        user: { email: string; user_id: number };
      };
    },
    updated: { status: string; reviewed_by_user_id: number | null },
    decision: 'APPROVED' | 'DENIED',
    notes: string | null,
  ) {
    const scholarUserId = existing.scholar_profile.user_id;
    const studentName =
      `${existing.scholar_profile.first_name} ${existing.scholar_profile.last_name}`.trim() ||
      'Scholar';
    const changeLabel =
      CHANGE_TYPE_LABELS[existing.change_type as AcademicChangeType] || 'Academic Change';
    const requestedSummary = [
      existing.requested_course_of_study ? `Program: ${existing.requested_course_of_study}` : null,
      existing.requested_school_name ? `School: ${existing.requested_school_name}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    await this.auditService.log(
      updated.reviewed_by_user_id ?? scholarUserId,
      decision === 'APPROVED' ? 'ACADEMIC_CHANGE_APPROVED' : 'ACADEMIC_CHANGE_DENIED',
      `Grantor ${decision.toLowerCase()} ${changeLabel} for ${studentName} (${requestedSummary})${notes ? ` — Notes: ${notes}` : ''}`,
    );

    try {
      await Promise.all([
        this.notificationsService.notifyUser(scholarUserId, {
          title:
            decision === 'APPROVED'
              ? `${changeLabel} Confirmed`
              : `${changeLabel} Declined`,
          message:
            decision === 'APPROVED'
              ? `Your request (${requestedSummary}) has been confirmed by the Grantor. You may now upload your new prospectus on the Prospectus page.`
              : `Your ${changeLabel.toLowerCase()} request (${requestedSummary}) was declined by the Grantor.${notes ? ` Notes: ${notes}` : ''}`,
          category: 'system',
          link: '/scholarProspectus',
        }),
        this.notificationsService.notifyCoordinators({
          title: `[CC] ${changeLabel} ${decision === 'APPROVED' ? 'Confirmed' : 'Declined'}`,
          message:
            decision === 'APPROVED'
              ? `Grantor confirmed ${studentName}'s ${changeLabel.toLowerCase()} (${requestedSummary}). Baseline unlocked for new prospectus submission.`
              : `Grantor declined ${studentName}'s ${changeLabel.toLowerCase()} request.`,
          category: 'system',
          link: '/CoordinatorMonitor?tab=shift-requests',
        }),
      ]);
    } catch (err) {
      this.logger.warn(`Failed to dispatch decision notifications: ${err}`);
    }

    if (existing.scholar_profile.user.email) {
      try {
        await this.mailService.sendAcademicChangeDecisionEmail(
          existing.scholar_profile.user.email,
          {
            studentName,
            changeLabel,
            requestedSummary,
            decision,
            decisionNotes: notes,
          },
        );
      } catch (err) {
        this.logger.warn(`Failed to send academic change decision email: ${err}`);
      }
    }

    const socketPayload = {
      request_id: existing.request_id,
      scholar_profile_id: existing.scholar_profile_id,
      status: updated.status,
      decision,
    };
    this.eventsGateway.emitToStaff('academic_change:reviewed', socketPayload);
    this.eventsGateway.emitToUser(scholarUserId, 'academic_change:reviewed', socketPayload);

    await Promise.all([
      this.cacheService.del(`baseline:scholar:${scholarUserId}`),
      this.cacheService.del(`baseline:review:${existing.scholar_profile_id}`),
      this.cacheService.del(`dashboard:scholar:${scholarUserId}`),
      this.cacheService.delPattern('dashboard:coordinator:'),
      this.cacheService.delPattern('dashboard:'),
    ]);
  }
}
