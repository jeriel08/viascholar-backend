import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationInterviewsService } from './application-interviews.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { GoogleCalendarService } from '../../google-calendar/google-calendar.service.js';
import { MailService } from '../../mail/mail.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import type { ScheduleInterviewDto } from '../dto/schedule-interview.dto.js';
import type { RequestRescheduleDto } from '../dto/request-reschedule.dto.js';
import type { RescheduleInterviewDto } from '../dto/reschedule-interview.dto.js';
import type { CancelInterviewDto } from '../dto/cancel-interview.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
  },
  employee: {
    findUnique: vi.fn(),
  },
  application: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  scholarDocument: {
    findMany: vi.fn(),
  },
  meeting: {
    upsert: vi.fn(),
  },
  $transaction: vi.fn(),
});

const createAuditMock = () => ({ log: vi.fn() });
const createCalendarMock = () => ({
  createInterviewEvent: vi.fn(),
  updateInterviewEvent: vi.fn(),
  deleteInterviewEvent: vi.fn(),
});
const createMailMock = () => ({
  sendInterviewScheduled: vi.fn(),
  sendInterviewRescheduleRequestedStaff: vi.fn(),
  sendInterviewRescheduled: vi.fn(),
  sendInterviewCancelled: vi.fn(),
  getStaffEmails: vi.fn().mockResolvedValue([]),
});
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createNotificationsMock = () => ({
  notifyStaff: vi.fn(),
  notifyUser: vi.fn(),
});

const makeApplication = (overrides: Record<string, unknown> = {}) => ({
  application_id: 42,
  scholar_profile_id: 11,
  interview_at: new Date('2026-08-15T10:00:00.000Z'),
  interview_meeting_link: 'https://meet.google.com/abc-defg-hij',
  interview_calendar_event_id: 'event-123',
  provider_notes: 'Original notes',
  scholar_profile: {
    profile_id: 11,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    user_id: 7,
    user: { user_id: 7, email: 'juan@example.com' },
  },
  ...overrides,
});

const makeEmployee = () => ({
  employee_id: 2,
  first_name: 'Maria',
  last_name: 'Santos',
  user: { user_id: 2, email: 'staff@example.com' },
});

const scheduleDto = {
  interview_at: '2026-08-15T10:00:00.000Z',
  duration_minutes: 60,
  provider_notes: 'Bring grade slip',
} as ScheduleInterviewDto;

const rescheduleDto = {
  reason: 'Work conflict',
  preferred_availability: 'Evenings',
} as RequestRescheduleDto;

const rescheduleInterviewDto = {
  new_interview_at: '2026-09-01T10:00:00.000Z',
  duration_minutes: 60,
  reschedule_notes: 'Rescheduled by staff',
} as RescheduleInterviewDto;

const cancelDto = {
  reason: 'Scholar withdrew',
} as CancelInterviewDto;

describe('ApplicationInterviewsService', () => {
  let service: ApplicationInterviewsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let calendar: ReturnType<typeof createCalendarMock>;
  let mail: ReturnType<typeof createMailMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    calendar = createCalendarMock();
    mail = createMailMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.employee.findUnique.mockResolvedValue(makeEmployee());
    prisma.application.findUnique.mockResolvedValue(makeApplication());
    prisma.scholarProfile.findUnique.mockResolvedValue({
      profile_id: 11,
      first_name: 'Juan',
      last_name: 'Dela Cruz',
      user_id: 7,
      applications: [
        {
          application_id: 42,
          interview_at: new Date('2026-08-15T10:00:00.000Z'),
        },
      ],
      user: { user_id: 7, email: 'juan@example.com' },
    });
    prisma.scholarDocument.findMany.mockResolvedValue([
      { document_id: 1, status: 'STUDENT_CONFIRMED' },
    ]);
    prisma.application.update.mockResolvedValue({
      application_id: 42,
      stage: 'Interview Scheduled',
    });
    prisma.meeting.upsert.mockResolvedValue({ meeting_id: 1 });
    prisma.$transaction.mockImplementation(
      async (promises: Promise<unknown>[]) => Promise.all(promises),
    );

    calendar.createInterviewEvent.mockResolvedValue({
      meetingUrl: 'https://meet.google.com/confirmed',
      eventId: 'event-abc',
    });
    calendar.updateInterviewEvent.mockResolvedValue({
      meetingUrl: 'https://meet.google.com/updated',
    });
    calendar.deleteInterviewEvent.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationInterviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: GoogleCalendarService, useValue: calendar },
        { provide: MailService, useValue: mail },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<ApplicationInterviewsService>(
      ApplicationInterviewsService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('scheduleInterview', () => {
    it('throws BadRequestException when the staff employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(2, 42, scheduleDto),
      ).rejects.toThrow(
        new BadRequestException('Reviewing staff employee record not found.'),
      );
    });

    it('throws NotFoundException when the application does not exist', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(2, 999, scheduleDto),
      ).rejects.toThrow('Application ID 999 not found.');
    });

    it('requires at least one submitted document', async () => {
      prisma.scholarDocument.findMany.mockResolvedValue([]);

      await expect(
        service.scheduleInterview(2, 42, scheduleDto),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot schedule interview because the applicant has not submitted any documents.',
        ),
      );
    });

    it('requires the documents to be confirmed by the applicant', async () => {
      prisma.scholarDocument.findMany.mockResolvedValue([
        { document_id: 1, status: 'PENDING_REVIEW' },
      ]);

      await expect(
        service.scheduleInterview(2, 42, scheduleDto),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot schedule interview because submitted document(s) have not been confirmed by the applicant yet.',
        ),
      );
    });

    it('rejects an unparseable interview date', async () => {
      await expect(
        service.scheduleInterview(2, 42, {
          ...scheduleDto,
          interview_at: 'not-a-date',
        }),
      ).rejects.toThrow(
        new BadRequestException('Invalid interview date/time provided.'),
      );
    });

    it('creates a calendar event and records the interview transactionally', async () => {
      await service.scheduleInterview(2, 42, scheduleDto);

      expect(calendar.createInterviewEvent).toHaveBeenCalledWith(
        objectMatching({
          title: 'ViaScholar Scholarship Interview - Juan Dela Cruz',
          durationMinutes: 60,
          attendeeEmails: ['juan@example.com', 'staff@example.com'],
          startTime: new Date('2026-08-15T10:00:00.000Z'),
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledWith([
        anyArg(Promise),
        anyArg(Promise),
      ]);
      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({
          status: 'UNDER_REVIEW',
          stage: 'Interview Scheduled',
          interview_meeting_link: 'https://meet.google.com/confirmed',
          interview_calendar_event_id: 'event-abc',
          reviewed_by_employee_id: 2,
        }),
      });
      expect(prisma.meeting.upsert).toHaveBeenCalledWith(
        objectMatching({ where: { application_id: 42 } }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'INTERVIEW_SCHEDULED',
        expect.stringContaining('Interview scheduled for application ID 42'),
      );
      expect(mail.sendInterviewScheduled).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ studentName: 'Juan Dela Cruz' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'interview:scheduled',
        objectMatching({ applicationId: 42 }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Interview Scheduled' }),
      );
    });

    it('honors a manual meeting link without creating a calendar event', async () => {
      calendar.createInterviewEvent.mockResolvedValue({
        meetingUrl: 'https://meet.jit.si/manual-room',
      });

      await service.scheduleInterview(2, 42, {
        ...scheduleDto,
        manual_meeting_link: 'https://meet.jit.si/manual-room',
      });

      expect(calendar.createInterviewEvent).toHaveBeenCalledWith(
        objectMatching({
          manualLink: 'https://meet.jit.si/manual-room',
        }),
      );
    });
  });

  describe('requestReschedule', () => {
    it('throws NotFoundException when the student has no application', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue({
        profile_id: 11,
        applications: [],
        user: { email: 'juan@example.com' },
      });

      await expect(service.requestReschedule(7, rescheduleDto)).rejects.toThrow(
        'No application found for this student.',
      );
    });

    it('rejects a reschedule when there is no scheduled interview', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue({
        profile_id: 11,
        applications: [{ application_id: 42, interview_at: null }],
        user: { email: 'juan@example.com' },
      });

      await expect(service.requestReschedule(7, rescheduleDto)).rejects.toThrow(
        new BadRequestException(
          'There is no scheduled interview to reschedule.',
        ),
      );
    });

    it('stores the combined reason and availability and notifies staff', async () => {
      await service.requestReschedule(7, rescheduleDto);

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: {
          stage: 'Interview Reschedule Requested',
          stage_updated_at: anyArg(Date),
          reschedule_reason: 'Work conflict | Preferred: Evenings',
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'INTERVIEW_RESCHEDULE_REQUESTED',
        expect.stringContaining('Work conflict | Preferred: Evenings'),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'interview:reschedule_requested',
        objectMatching({ applicationId: 42 }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'Interview Reschedule Requested' }),
      );
    });

    it('omits the preferred availability suffix when not provided', async () => {
      await service.requestReschedule(7, {
        reason: 'Work conflict',
      });

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({
          reschedule_reason: 'Work conflict',
        }),
      });
    });
  });

  describe('rescheduleInterview', () => {
    it('throws BadRequestException when the staff employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.rescheduleInterview(2, 42, rescheduleInterviewDto),
      ).rejects.toThrow('Reviewing staff employee record not found.');
    });

    it('throws NotFoundException when the application does not exist', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await expect(
        service.rescheduleInterview(2, 999, rescheduleInterviewDto),
      ).rejects.toThrow('Application ID 999 not found.');
    });

    it('rejects an unparseable reschedule date', async () => {
      await expect(
        service.rescheduleInterview(2, 42, {
          ...rescheduleInterviewDto,
          new_interview_at: 'bogus',
        }),
      ).rejects.toThrow('Invalid interview date/time provided.');
    });

    it('updates the existing calendar event when one is linked', async () => {
      await service.rescheduleInterview(2, 42, rescheduleInterviewDto);

      expect(calendar.updateInterviewEvent).toHaveBeenCalledWith(
        'event-123',
        objectMatching({
          newStartTime: new Date('2026-09-01T10:00:00.000Z'),
          durationMinutes: 60,
          notes: 'Rescheduled by staff',
        }),
      );
      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({
          stage: 'Interview Rescheduled',
          interview_meeting_link: 'https://meet.google.com/updated',
          reviewed_by_employee_id: 2,
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'INTERVIEW_RESCHEDULED',
        expect.stringContaining('to 2026-09-01T10:00:00.000Z'),
      );
    });

    it('skips the calendar update when there is no linked event and no manual link', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_calendar_event_id: null }),
      );

      await service.rescheduleInterview(2, 42, rescheduleInterviewDto);

      expect(calendar.updateInterviewEvent).not.toHaveBeenCalled();
    });

    it('uses the manual link when there is no calendar event id', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_calendar_event_id: null }),
      );

      await service.rescheduleInterview(2, 42, {
        ...rescheduleInterviewDto,
        manual_meeting_link: 'https://meet.jit.si/manual',
      });

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({
          interview_meeting_link: 'https://meet.jit.si/manual',
        }),
      });
    });
  });

  describe('cancelInterview', () => {
    it('throws BadRequestException when the staff employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.cancelInterview(2, 42, cancelDto)).rejects.toThrow(
        'Reviewing staff employee record not found.',
      );
    });

    it('throws NotFoundException when the application does not exist', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await expect(service.cancelInterview(2, 42, cancelDto)).rejects.toThrow(
        'Application ID 42 not found.',
      );
    });

    it('rejects cancelling an application with no active interview', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_at: null }),
      );

      await expect(service.cancelInterview(2, 42, cancelDto)).rejects.toThrow(
        new BadRequestException(
          'Application ID 42 has no active interview to cancel.',
        ),
      );
    });

    it('deletes the linked calendar event and clears the interview', async () => {
      await service.cancelInterview(2, 42, cancelDto);

      expect(calendar.deleteInterviewEvent).toHaveBeenCalledWith('event-123');
      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({
          stage: 'Under review',
          status: 'UNDER_REVIEW',
          interview_at: null,
          interview_meeting_link: null,
          interview_calendar_event_id: null,
          reschedule_reason: 'Scholar withdrew',
        }),
      });
      expect(prisma.meeting.upsert).toHaveBeenCalledWith(
        objectMatching({
          update: { status: 'CANCELLED', notes: 'Scholar withdrew' },
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'INTERVIEW_CANCELLED',
        expect.stringContaining('Scholar withdrew'),
      );
      expect(mail.sendInterviewCancelled).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ studentName: 'Juan Dela Cruz' }),
      );
    });

    it('skips the calendar deletion when no event is linked', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_calendar_event_id: null }),
      );

      await service.cancelInterview(2, 42, cancelDto);

      expect(calendar.deleteInterviewEvent).not.toHaveBeenCalled();
    });
  });
});
