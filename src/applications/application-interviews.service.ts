import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service.js';
import { MailService } from '../mail/mail.service.js';
import { ScheduleInterviewDto } from './dto/schedule-interview.dto.js';
import { RequestRescheduleDto } from './dto/request-reschedule.dto.js';
import { RescheduleInterviewDto } from './dto/reschedule-interview.dto.js';
import { CancelInterviewDto } from './dto/cancel-interview.dto.js';

// meetings.meeting_date is a DATE column — strip the time portion in UTC.
function toDateOnly(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

@Injectable()
export class ApplicationInterviewsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private googleCalendarService: GoogleCalendarService,
    private mailService: MailService,
  ) {}

  // 1. Staff schedules interview with automated Google Meet & Calendar creation
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

    const [updated] = await this.prisma.$transaction([
      this.prisma.application.update({
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
      }),
      this.prisma.meeting.upsert({
        where: { application_id: applicationId },
        create: {
          application_id: applicationId,
          scholar_profile_id: application.scholar_profile_id,
          employee_id: employee.employee_id,
          title: `ViaScholar Scholarship Interview - ${studentName}`,
          meeting_date: toDateOnly(startTime),
          scheduled_at: startTime,
          duration_minutes: dto.duration_minutes || 45,
          meeting_link: calendarResult.meetingUrl,
          calendar_event_id: calendarResult.eventId,
          status: 'SCHEDULED',
          notes: dto.provider_notes,
        },
        update: {
          scholar_profile_id: application.scholar_profile_id,
          employee_id: employee.employee_id,
          title: `ViaScholar Scholarship Interview - ${studentName}`,
          meeting_date: toDateOnly(startTime),
          scheduled_at: startTime,
          duration_minutes: dto.duration_minutes || 45,
          meeting_link: calendarResult.meetingUrl,
          calendar_event_id: calendarResult.eventId,
          status: 'SCHEDULED',
          notes: dto.provider_notes,
        },
      }),
    ]);

    await this.auditService.log(
      employeeUserId,
      'INTERVIEW_SCHEDULED',
      `Interview scheduled for application ID ${applicationId} on ${startTime.toISOString()} with meeting link ${calendarResult.meetingUrl}.`,
    );

    // Send interview invitation email to student
    if (studentEmail) {
      void this.mailService.sendInterviewScheduled(studentEmail, {
        studentName,
        interviewAt: startTime,
        meetingLink: calendarResult.meetingUrl,
        notes: dto.provider_notes,
      });
    }

    return updated;
  }

  // 2. Student requests interview rescheduling
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

    void this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        void this.mailService.sendInterviewRescheduleRequestedStaff(
          staffEmails,
          {
            studentName,
            reason: formattedReason,
            applicationId: application.application_id,
          },
        );
      }
    });

    return updated;
  }

  // 3. Staff reschedules interview with updated Google Calendar event & Meet link
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

    const studentName =
      `${application.scholar_profile?.first_name} ${application.scholar_profile?.last_name}`.trim() ||
      'Applicant';

    let meetingUrl = application.interview_meeting_link;
    const eventId = application.interview_calendar_event_id;

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

    const [updated] = await this.prisma.$transaction([
      this.prisma.application.update({
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
      }),
      this.prisma.meeting.upsert({
        where: { application_id: applicationId },
        create: {
          application_id: applicationId,
          scholar_profile_id: application.scholar_profile_id,
          employee_id: employee.employee_id,
          title: `ViaScholar Scholarship Interview - ${studentName}`,
          meeting_date: toDateOnly(newStartTime),
          scheduled_at: newStartTime,
          duration_minutes: dto.duration_minutes || 45,
          meeting_link: meetingUrl,
          status: 'RESCHEDULED',
          notes: dto.reschedule_notes || application.provider_notes,
        },
        update: {
          meeting_date: toDateOnly(newStartTime),
          scheduled_at: newStartTime,
          duration_minutes: dto.duration_minutes || 45,
          meeting_link: meetingUrl,
          status: 'RESCHEDULED',
          notes: dto.reschedule_notes || application.provider_notes,
        },
      }),
    ]);

    await this.auditService.log(
      employeeUserId,
      'INTERVIEW_RESCHEDULED',
      `Interview rescheduled for application ID ${applicationId} to ${newStartTime.toISOString()}.`,
    );

    // Send updated schedule email to student
    const studentEmail = application.scholar_profile?.user?.email;

    if (studentEmail) {
      void this.mailService.sendInterviewRescheduled(studentEmail, {
        studentName,
        newInterviewAt: newStartTime,
        meetingLink: meetingUrl || undefined,
        notes: dto.reschedule_notes,
      });
    }

    return updated;
  }

  // 4. Staff cancels an interview: drop the calendar event (best effort),
  // mark the mirrored meeting CANCELLED, and return the application to review.
  async cancelInterview(
    employeeUserId: number,
    applicationId: number,
    dto: CancelInterviewDto,
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

    if (!application.interview_at) {
      throw new BadRequestException(
        `Application ID ${applicationId} has no active interview to cancel.`,
      );
    }

    const scheduledAt = application.interview_at;
    const studentName =
      `${application.scholar_profile?.first_name} ${application.scholar_profile?.last_name}`.trim() ||
      'Applicant';
    const studentEmail = application.scholar_profile?.user?.email;

    // Best effort — the calendar service never throws, it only logs.
    if (application.interview_calendar_event_id) {
      await this.googleCalendarService.deleteInterviewEvent(
        application.interview_calendar_event_id,
      );
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.application.update({
        where: { application_id: applicationId },
        data: {
          status: 'UNDER_REVIEW',
          stage: 'Under review',
          stage_updated_at: new Date(),
          interview_at: null,
          interview_meeting_link: null,
          interview_calendar_event_id: null,
          reschedule_reason: dto.reason ?? null,
          reviewed_by_employee_id: employee.employee_id,
        },
      }),
      this.prisma.meeting.upsert({
        where: { application_id: applicationId },
        create: {
          application_id: applicationId,
          scholar_profile_id: application.scholar_profile_id,
          employee_id: employee.employee_id,
          title: `ViaScholar Scholarship Interview - ${studentName}`,
          meeting_date: toDateOnly(scheduledAt),
          scheduled_at: scheduledAt,
          status: 'CANCELLED',
          notes: dto.reason,
        },
        update: {
          status: 'CANCELLED',
          notes: dto.reason,
        },
      }),
    ]);

    await this.auditService.log(
      employeeUserId,
      'INTERVIEW_CANCELLED',
      `Interview cancelled for application ID ${applicationId} (was ${scheduledAt.toISOString()}). Reason: ${dto.reason ?? 'none given'}.`,
    );

    if (studentEmail) {
      void this.mailService.sendInterviewCancelled(studentEmail, {
        studentName,
        scheduledAt,
        reason: dto.reason,
      });
    }

    return updated;
  }
}
