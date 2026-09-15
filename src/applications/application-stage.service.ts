import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { UpdateApplicationStageDto } from './dto/update-stage.dto.js';
import { EventsGateway } from '../events/events.gateway.js';

@Injectable()
export class ApplicationStageService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private eventsGateway: EventsGateway,
  ) {}

  // Staff updates application stage (Review, Schedule Interview, Approve, Reject)
  async updateStage(
    employeeUserId: number,
    applicationId: number,
    dto: UpdateApplicationStageDto,
    callerRole: string,
  ) {
    const canDecide = ['ADMIN', 'GRANTOR'].includes(callerRole);
    if (!canDecide && ['APPROVED', 'REJECTED'].includes(dto.status)) {
      throw new ForbiddenException(
        'Only grantors can approve or reject applications.',
      );
    }

    if (dto.status === 'REJECTED' && !dto.rejection_reason) {
      throw new BadRequestException(
        'A rejection reason is required when rejecting an application.',
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
        rejection_reason: dto.rejection_reason,
        reviewed_by_employee_id: employee.employee_id,
        decision_at: ['APPROVED', 'REJECTED'].includes(dto.status)
          ? new Date()
          : undefined,
      },
    });

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
    }

    return updated;
  }
}
