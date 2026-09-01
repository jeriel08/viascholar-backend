import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service.js';
import { MailService } from '../mail/mail.service.js';
import { CreateApplicationDto } from './dto/create-application.dto.js';
import { QueryApplicationsDto } from './dto/query-applications.dto.js';
import { UpdateApplicationStageDto } from './dto/update-stage.dto.js';
import { ScheduleInterviewDto } from './dto/schedule-interview.dto.js';
import { RequestRescheduleDto } from './dto/request-reschedule.dto.js';
import { RescheduleInterviewDto } from './dto/reschedule-interview.dto.js';

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private googleCalendarService: GoogleCalendarService,
    private mailService: MailService,
  ) {}

  // 1. Scholar submits or updates their application details
  async submitApplication(userId: number, dto: CreateApplicationDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { applications: true, user: true },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    // Update track and course on scholar profile
    await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        scholarship_track: dto.scholarship_track,
        course_of_study: dto.course_of_study,
        school_name: dto.school_name,
        relative_employee: dto.relative_employee,
      },
    });

    // Find existing application or create new one
    let application = scholar.applications[0];

    if (!application) {
      application = await this.prisma.application.create({
        data: {
          scholar_profile_id: scholar.profile_id,
          stage: 'Submitted',
          status: 'PENDING',
        },
      });
    }

    await this.auditService.log(
      userId,
      'APPLICATION_SUBMITTED',
      `Scholar (User ID: ${userId}) submitted application (ID: ${application.application_id}).`,
    );

    // Dispatch emails (non-blocking)
    const studentName =
      `${scholar.first_name} ${scholar.last_name}`.trim() || 'Applicant';

    if (scholar.user?.email) {
      this.mailService.sendApplicationSubmittedStudent(scholar.user.email, {
        studentName,
        track: dto.scholarship_track,
        applicationId: application.application_id,
      });
    }

    this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        this.mailService.sendApplicationSubmittedStaff(staffEmails, {
          studentName,
          track: dto.scholarship_track,
          course: dto.course_of_study,
          school: dto.school_name,
          applicationId: application.application_id,
        });
      }
    });

    return application;
  }

  // 2. Scholar views their own application progress timeline
  async getMyApplication(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        applications: {
          include: { reviewed_by_employee: true },
        },
        documents: true,
      },
    });

    if (!scholar || scholar.applications.length === 0) {
      throw new NotFoundException(
        'No active application found for this scholar.',
      );
    }

    return scholar.applications[0];
  }

  // 3. Staff list all applications with filters
  async findAll(query: QueryApplicationsDto) {
    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.track) {
      where.scholar_profile = { scholarship_track: query.track };
    }

    if (query.search) {
      where.scholar_profile = {
        OR: [
          { first_name: { contains: query.search, mode: 'insensitive' } },
          { last_name: { contains: query.search, mode: 'insensitive' } },
          { student_number: { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }

    return this.prisma.application.findMany({
      where,
      orderBy: { submitted_at: 'desc' },
      include: {
        scholar_profile: true,
        reviewed_by_employee: true,
      },
    });
  }

  // 4. Staff updates application stage (Review, Schedule Interview, Approve, Reject)
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

    const updated = await this.prisma.application.update({
      where: { application_id: applicationId },
      data: {
        status: dto.status,
        stage: dto.stage,
        stage_updated_at: new Date(),
        interview_at: dto.interview_at
          ? new Date(dto.interview_at)
          : undefined,
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
        this.mailService.sendApplicationApproved(studentEmail, {
          studentName,
          track: application.scholar_profile?.scholarship_track || undefined,
        });
      } else if (dto.status === 'REJECTED') {
        this.mailService.sendApplicationRejected(studentEmail, {
          studentName,
          reason: dto.rejection_reason,
        });
      } else {
        this.mailService.sendStageUpdated(studentEmail, {
          studentName,
          stage: dto.stage,
          status: dto.status,
          notes: dto.provider_notes,
        });
      }
    }

    return updated;
  }

  // 5. Staff schedules interview with automated Google Meet & Calendar creation
  async scheduleInterview(
    employeeUserId: number,
    applicationId: number,
    dto: ScheduleInterviewDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
      include: { user: true },
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

    const startTime = new Date(dto.interview_at);
    if (isNaN(startTime.getTime())) {
      throw new BadRequestException('Invalid interview date/time provided.');
    }

    const studentName =
      `${application.scholar_profile.first_name} ${application.scholar_profile.last_name}`.trim() ||
      'Applicant';
    const studentEmail = application.scholar_profile.user.email;
    const staffEmail = employee.user.email;

    const calendarResult =
      await this.googleCalendarService.createInterviewEvent({
        title: `ViaScholar Scholarship Interview - ${studentName}`,
        description:
          dto.provider_notes ||
          `Scholarship evaluation interview for ${studentName}.`,
        startTime,
        durationMinutes: dto.duration_minutes || 45,
        attendeeEmails: [studentEmail, staffEmail].filter(Boolean),
        manualLink: dto.manual_meeting_link,
      });

    const updated = await this.prisma.application.update({
      where: { application_id: applicationId },
      data: {
        status: 'UNDER_REVIEW',
        stage: 'Interview Scheduled',
        stage_updated_at: new Date(),
        interview_at: startTime,
        interview_meeting_link: calendarResult.meetingUrl,
        interview_calendar_event_id: calendarResult.eventId,
        provider_notes: dto.provider_notes,
        reschedule_reason: null,
        reviewed_by_employee_id: employee.employee_id,
      },
    });

    await this.auditService.log(
      employeeUserId,
      'INTERVIEW_SCHEDULED',
      `Interview scheduled for application ID ${applicationId} on ${startTime.toISOString()} with meeting link ${calendarResult.meetingUrl}.`,
    );

    // Send interview invitation email to student
    if (studentEmail) {
      this.mailService.sendInterviewScheduled(studentEmail, {
        studentName,
        interviewAt: startTime,
        meetingLink: calendarResult.meetingUrl,
        notes: dto.provider_notes,
      });
    }

    return updated;
  }

  // 6. Student requests interview rescheduling
  async requestReschedule(studentUserId: number, dto: RequestRescheduleDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: studentUserId },
      include: {
        applications: {
          orderBy: { submitted_at: 'desc' },
          take: 1,
        },
        user: true,
      },
    });

    if (!scholar || scholar.applications.length === 0) {
      throw new NotFoundException('No application found for this student.');
    }

    const application = scholar.applications[0];
    if (!application.interview_at) {
      throw new BadRequestException(
        'There is no scheduled interview to reschedule.',
      );
    }

    const formattedReason =
      dto.reason +
      (dto.preferred_availability
        ? ` | Preferred: ${dto.preferred_availability}`
        : '');

    const updated = await this.prisma.application.update({
      where: { application_id: application.application_id },
      data: {
        stage: 'Interview Reschedule Requested',
        stage_updated_at: new Date(),
        reschedule_reason: formattedReason,
      },
    });

    await this.auditService.log(
      studentUserId,
      'INTERVIEW_RESCHEDULE_REQUESTED',
      `Student requested interview reschedule for application ID ${application.application_id}. Reason: ${formattedReason}`,
    );

    // Notify staff of the reschedule request
    const studentName =
      `${scholar.first_name} ${scholar.last_name}`.trim() || 'Applicant';

    this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        this.mailService.sendInterviewRescheduleRequestedStaff(staffEmails, {
          studentName,
          reason: formattedReason,
          applicationId: application.application_id,
        });
      }
    });

    return updated;
  }

  // 7. Staff reschedules interview with updated Google Calendar event & Meet link
  async rescheduleInterview(
    employeeUserId: number,
    applicationId: number,
    dto: RescheduleInterviewDto,
  ) {
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

    const newStartTime = new Date(dto.new_interview_at);
    if (isNaN(newStartTime.getTime())) {
      throw new BadRequestException('Invalid interview date/time provided.');
    }

    let meetingUrl = application.interview_meeting_link;
    let eventId = application.interview_calendar_event_id;

    if (eventId) {
      const updateResult =
        await this.googleCalendarService.updateInterviewEvent(eventId, {
          newStartTime,
          durationMinutes: dto.duration_minutes || 45,
          notes: dto.reschedule_notes,
          manualLink: dto.manual_meeting_link,
        });
      if (updateResult.meetingUrl) {
        meetingUrl = updateResult.meetingUrl;
      }
    } else if (dto.manual_meeting_link) {
      meetingUrl = dto.manual_meeting_link;
    }

    const updated = await this.prisma.application.update({
      where: { application_id: applicationId },
      data: {
        stage: 'Interview Rescheduled',
        stage_updated_at: new Date(),
        interview_at: newStartTime,
        interview_meeting_link: meetingUrl,
        provider_notes: dto.reschedule_notes || application.provider_notes,
        reschedule_reason: null,
        reviewed_by_employee_id: employee.employee_id,
      },
    });

    await this.auditService.log(
      employeeUserId,
      'INTERVIEW_RESCHEDULED',
      `Interview rescheduled for application ID ${applicationId} to ${newStartTime.toISOString()}.`,
    );

    // Send updated schedule email to student
    const studentEmail = application.scholar_profile?.user?.email;
    const studentName =
      `${application.scholar_profile?.first_name} ${application.scholar_profile?.last_name}`.trim() ||
      'Applicant';

    if (studentEmail) {
      this.mailService.sendInterviewRescheduled(studentEmail, {
        studentName,
        newInterviewAt: newStartTime,
        meetingLink: meetingUrl || undefined,
        notes: dto.reschedule_notes,
      });
    }

    return updated;
  }
}

