import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { UpdateApplicationStageDto } from '../dto/update-stage.dto.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

function studentNameHelper(
  profile?: { first_name: string | null; last_name: string | null } | null,
) {
  return `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || 'Applicant';
}

@Injectable()
export class ApplicationStageService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private eventsGateway: EventsGateway,
    private notificationsService: NotificationsService,
    private cacheService: AppCacheService,
  ) {}

  // Staff updates application stage (Review, Schedule Interview, Approve, Reject)
  async updateStage(
    employeeUserId: number,
    applicationId: number,
    dto: UpdateApplicationStageDto,
    callerRole: string,
  ) {
    const canApprove = ['ADMIN', 'GRANTOR'].includes(callerRole);
    if (!canApprove && dto.status === 'APPROVED') {
      throw new ForbiddenException(
        'Only grantors and administrators can approve applications.',
      );
    }

    const canReject = ['ADMIN', 'GRANTOR', 'COORDINATOR'].includes(callerRole);
    if (!canReject && dto.status === 'REJECTED') {
      throw new ForbiddenException(
        'You do not have permission to reject applications.',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });

    if (!employee) {
      throw new BadRequestException(
        'Reviewing staff employee record not found.',
      );
    }

    const application = await this.prisma.application.findUnique({
      where: { application_id: applicationId },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });

    if (!application) {
      throw new NotFoundException(`Application ID ${applicationId} not found.`);
    }

    // Check if moving to Interview without confirmed submitted documents
    const isMovingToInterview = dto.stage.toLowerCase().includes('interview');
    if (isMovingToInterview) {
      const docs = await this.prisma.scholarDocument.findMany({
        where: { scholar_profile_id: application.scholar_profile_id },
        select: { document_id: true, status: true },
      });
      if (docs.length === 0) {
        throw new BadRequestException(
          'Cannot pass applicant to interview because no documents have been submitted.',
        );
      }
      const hasConfirmed = docs.some(
        (d) => d.status === 'STUDENT_CONFIRMED' || d.status === 'VERIFIED',
      );
      if (!hasConfirmed) {
        throw new BadRequestException(
          'Cannot pass applicant to interview: Submitted document(s) have not been confirmed by the applicant yet.',
        );
      }
    }

    // Check if an interview has already taken place
    const hasCompletedInterview = Boolean(
      application.interview_at &&
      new Date(application.interview_at) <= new Date(),
    );

    const isCoordinatorAccepting =
      callerRole === 'COORDINATOR' &&
      (dto.stage.toLowerCase().includes('accept') ||
        dto.stage.toLowerCase().includes('grantor') ||
        dto.stage.toLowerCase().includes('recommend') ||
        dto.stage.toLowerCase().includes('passed'));

    const isGrantorApproving = dto.status === 'APPROVED';

    if (
      (isCoordinatorAccepting || isGrantorApproving) &&
      !hasCompletedInterview &&
      !dto.confirm_without_meeting
    ) {
      throw new BadRequestException({
        code: 'MEETING_CONFIRMATION_REQUIRED',
        message: isGrantorApproving
          ? 'No completed interview has been recorded for this applicant. Do you wish to proceed with approval without an interview?'
          : 'An interview has not yet been conducted with this applicant. Do you wish to accept/recommend this applicant without an interview?',
        interview_at: application.interview_at,
      });
    }

    const decisionAt = ['APPROVED', 'REJECTED'].includes(dto.status)
      ? new Date()
      : null;

    const updated = await this.prisma.application.update({
      where: { application_id: applicationId },
      data: {
        status: dto.status,
        stage: dto.stage,
        stage_updated_at: new Date(),
        interview_at: dto.interview_at ? new Date(dto.interview_at) : undefined,
        interview_meeting_link: dto.interview_meeting_link,
        interview_calendar_event_id: dto.interview_calendar_event_id,
        reschedule_reason: dto.reschedule_reason,
        provider_notes: dto.provider_notes,
        rejection_reason:
          dto.status === 'REJECTED'
            ? dto.rejection_reason?.trim() || null
            : null,
        reviewed_by_employee_id: employee.employee_id,
        decision_at: decisionAt,
        archived_at:
          dto.status === 'REJECTED' ? new Date() : dto.status === 'APPROVED' ? null : undefined,
      },
    });

    // Applicants whose application is rejected are automatically archived.
    // If the decision is reversed to APPROVED, they are restored.
    if (dto.status === 'REJECTED') {
      const rejectionReason =
        dto.rejection_reason?.trim() || 'Application rejected by staff.';

      await this.prisma.scholarProfile.update({
        where: { profile_id: application.scholar_profile_id },
        data: {
          archived_at: new Date(),
          archived_by_user_id: employeeUserId,
          archive_reason: 'APPLICATION_REJECTED',
          archive_notes: rejectionReason,
        },
      });

      if (application.scholar_profile?.user_id) {
        await this.prisma.user.update({
          where: { user_id: application.scholar_profile.user_id },
          data: { is_active: false },
        });
      }

      await this.auditService.log(
        employeeUserId,
        'APPLICANT_ARCHIVED',
        `Automatically archived applicant '${studentNameHelper(application.scholar_profile)}' (Profile #${application.scholar_profile_id}) because the application was REJECTED.`,
      );

      await this.cacheService.delPattern('dashboard:');
      this.eventsGateway.emitToStaff('applicant:archived', {
        profile_id: application.scholar_profile_id,
        application_id: applicationId,
      });
    } else if (dto.status === 'APPROVED') {
      const profile = await this.prisma.scholarProfile.findUnique({
        where: { profile_id: application.scholar_profile_id },
      });

      if (
        profile?.archived_at &&
        profile.archive_reason === 'APPLICATION_REJECTED'
      ) {
        await this.prisma.scholarProfile.update({
          where: { profile_id: profile.profile_id },
          data: {
            archived_at: null,
            archived_by_user_id: null,
            archive_reason: null,
            archive_notes: null,
          },
        });

        await this.prisma.user.update({
          where: { user_id: profile.user_id },
          data: { is_active: true },
        });

        await this.auditService.log(
          employeeUserId,
          'APPLICANT_RESTORED',
          `Restored applicant '${studentNameHelper(profile)}' (Profile #${profile.profile_id}) because the application was re-approved.`,
        );

        await this.cacheService.delPattern('dashboard:');
        this.eventsGateway.emitToStaff('applicant:restored', {
          profile_id: profile.profile_id,
          application_id: applicationId,
        });
      }
    }

    // Audit log stage transition
    await this.auditService.log(
      employeeUserId,
      'APPLICATION_STAGE_UPDATED',
      `Application ID ${applicationId} stage updated to '${dto.stage}' (${dto.status}).`,
    );

    // Dispatch email notification to student
    const studentEmail = application.scholar_profile?.user?.email;
    const studentName =
      `${application.scholar_profile?.first_name} ${application.scholar_profile?.last_name}`.trim() ||
      'Applicant';

    if (studentEmail) {
      if (dto.status === 'APPROVED') {
        void this.mailService.sendApplicationApproved(studentEmail, {
          studentName,
          track: application.scholar_profile?.scholarship_track || undefined,
        });
      } else if (dto.status === 'REJECTED') {
        void this.mailService.sendApplicationRejected(studentEmail, {
          studentName,
          reason: dto.rejection_reason,
        });
      } else {
        void this.mailService.sendStageUpdated(studentEmail, {
          studentName,
          stage: dto.stage,
          status: dto.status,
          notes: dto.provider_notes,
        });
      }
    }

    // Real-time broadcast to staff and the applicant
    const stageEventPayload = {
      applicationId,
      scholarProfileId: application.scholar_profile_id,
      studentName,
      stage: dto.stage,
      status: dto.status,
      providerNotes: dto.provider_notes,
      rejectionReason: dto.rejection_reason,
      updatedAt: new Date().toISOString(),
    };
    this.eventsGateway.emitToStaff(
      'application:stage_updated',
      stageEventPayload,
    );
    if (application.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        application.scholar_profile.user_id,
        'application:stage_updated',
        stageEventPayload,
      );
      void this.notificationsService.notifyUser(
        application.scholar_profile.user_id,
        {
          title: 'Milestone Updated',
          message: `Your application has moved to ${dto.stage || dto.status}.`,
          category: 'application',
          link: '/ApplicantsDashboard',
        },
      );
    }

    void this.notificationsService.notifyStaff({
      title: 'Milestone Updated',
      message: `${studentName ? `${studentName}'s application` : 'Application'} moved to ${dto.stage || dto.status}.`,
      category: 'application',
      link: '/CoordinatorApplicants',
    });

    return updated;
  }
}
