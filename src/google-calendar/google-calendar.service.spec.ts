import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GoogleCalendarService } from './google-calendar.service.js';
import { ConfigService } from '@nestjs/config';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const { mockInsert, mockPatch, mockDelete } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockPatch: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        setCredentials = vi.fn();
      },
    },
    calendar: () => ({
      events: {
        insert: mockInsert,
        patch: mockPatch,
        delete: mockDelete,
      },
    }),
  },
}));

vi.mock('crypto', () => ({
  randomUUID: () => 'fixed-uuid-for-tests',
}));

const createConfigMock = (
  overrides: Record<string, string> = {},
): { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(
    (key: string) =>
      ({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REFRESH_TOKEN: 'refresh-token',
        GOOGLE_CALENDAR_ID: 'primary-calendar',
        ...overrides,
      })[key],
  ),
});

describe('GoogleCalendarService', () => {
  const buildService = async (config: ReturnType<typeof createConfigMock>) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleCalendarService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    return module.get<GoogleCalendarService>(GoogleCalendarService);
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockInsert.mockReset();
    mockPatch.mockReset();
    mockDelete.mockReset();

    mockInsert.mockResolvedValue({
      data: {
        id: 'event-123',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      },
    });
    mockPatch.mockResolvedValue({
      data: {
        id: 'event-123',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      },
    });
    mockDelete.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('configures the OAuth2 client and calendar when credentials are present', async () => {
    const service = await buildService(createConfigMock());

    expect(mockInsert).not.toHaveBeenCalled();
    await service.createInterviewEvent({
      title: 'G',
      startTime: new Date('2026-09-01T10:00:00.000Z'),
      attendeeEmails: ['student@example.com'],
    });

    expect(mockInsert).toHaveBeenCalled();
  });

  it('warns and uses fallback links when credentials are missing', async () => {
    const service = await buildService(
      createConfigMock({
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_REFRESH_TOKEN: '',
      }),
    );

    const result = await service.createInterviewEvent({
      title: 'Scholar Interview',
      startTime: new Date('2026-09-01T10:00:00.000Z'),
      attendeeEmails: ['student@example.com'],
    });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(result.meetingUrl).toMatch(/^https:\/\/meet\.jit\.si\//);
  });

  describe('createInterviewEvent', () => {
    it('returns the manual meeting link without calling the calendar API', async () => {
      const service = await buildService(createConfigMock());

      const result = await service.createInterviewEvent({
        title: 'Scholar Interview',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        attendeeEmails: ['student@example.com'],
        manualLink: 'https://meet.jit.si/manual',
      });

      expect(result).toEqual({ meetingUrl: 'https://meet.jit.si/manual' });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('creates a calendar event and returns the meeting url and event id', async () => {
      const service = await buildService(createConfigMock());

      const result = await service.createInterviewEvent({
        title: 'Scholar Interview with Juan Dela Cruz',
        description: 'Interview notes',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        durationMinutes: 60,
        attendeeEmails: ['student@example.com', '', 'staff@example.com'],
      });

      expect(mockInsert).toHaveBeenCalledWith(
        objectMatching({
          calendarId: 'primary-calendar',
          conferenceDataVersion: 1,
          sendUpdates: 'all',
          requestBody: objectMatching({
            summary: 'Scholar Interview with Juan Dela Cruz',
            description: 'Interview notes',
            attendees: [
              { email: 'student@example.com' },
              { email: 'staff@example.com' },
            ],
          }),
        }),
      );
      expect(result).toEqual({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        eventId: 'event-123',
      });
    });

    it('trims empty attendee emails', async () => {
      const service = await buildService(createConfigMock());

      await service.createInterviewEvent({
        title: 'Interview',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        attendeeEmails: ['a@example.com', '', 'b@example.com'],
      });

      const body = (
        mockInsert.mock.calls[0][0] as {
          requestBody: { attendees: Array<{ email: string }> };
        }
      ).requestBody;
      expect(body.attendees).toEqual([
        { email: 'a@example.com' },
        { email: 'b@example.com' },
      ]);
    });

    it('computes the event end time from duration', async () => {
      const service = await buildService(createConfigMock());

      await service.createInterviewEvent({
        title: 'Interview',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        durationMinutes: 90,
        attendeeEmails: ['student@example.com'],
      });

      const body = (
        mockInsert.mock.calls[0][0] as {
          requestBody: {
            start: { dateTime: string };
            end: { dateTime: string };
          };
        }
      ).requestBody;
      expect(body.start.dateTime).toBe('2026-09-01T10:00:00.000Z');
      expect(body.end.dateTime).toBe('2026-09-01T11:30:00.000Z');
    });

    it('uses the entry point video link when hangoutLink is missing', async () => {
      mockInsert.mockResolvedValue({
        data: {
          id: 'event-123',
          hangoutLink: null,
          conferenceData: {
            entryPoints: [
              { entryPointType: 'phone', uri: 'tel:+1-000' },
              { entryPointType: 'video', uri: 'https://meet.google.com/xyz' },
            ],
          },
        },
      });
      const service = await buildService(createConfigMock());

      const result = await service.createInterviewEvent({
        title: 'Interview',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        attendeeEmails: ['student@example.com'],
      });

      expect(result.meetingUrl).toBe('https://meet.google.com/xyz');
    });

    it('generates a Jitsi Meet fallback when the calendar API fails', async () => {
      mockInsert.mockRejectedValue(new Error('invalid refresh token'));
      const service = await buildService(createConfigMock());

      const result = await service.createInterviewEvent({
        title: 'Scholar Interview with Juan!',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        attendeeEmails: ['student@example.com'],
      });

      expect(result.meetingUrl).toMatch(
        /^https:\/\/meet\.jit\.si\/viascholar-scholar-interview-with-/,
      );
    });

    it('generates a Jitsi fallback when the event data has no usable link', async () => {
      mockInsert.mockResolvedValue({
        data: {
          id: 'event-123',
          hangoutLink: null,
          conferenceData: null,
        },
      });
      const service = await buildService(createConfigMock());

      const result = await service.createInterviewEvent({
        title: 'Interview',
        startTime: new Date('2026-09-01T10:00:00.000Z'),
        attendeeEmails: ['student@example.com'],
      });

      expect(result.meetingUrl).toMatch(/^https:\/\/meet\.jit\.si\//);
    });
  });

  describe('updateInterviewEvent', () => {
    it('returns the manual link without calling the calendar API', async () => {
      const service = await buildService(createConfigMock());

      const result = await service.updateInterviewEvent('event-123', {
        newStartTime: new Date('2026-09-01T10:00:00.000Z'),
        manualLink: 'https://meet.jit.si/manual',
      });

      expect(result).toEqual({
        meetingUrl: 'https://meet.jit.si/manual',
        eventId: 'event-123',
      });
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('updates the event and returns the new meeting link', async () => {
      const service = await buildService(createConfigMock());

      const result = await service.updateInterviewEvent('event-123', {
        newStartTime: new Date('2026-09-01T10:00:00.000Z'),
        durationMinutes: 30,
        notes: 'Bring your documents',
      });

      expect(mockPatch).toHaveBeenCalledWith(
        objectMatching({
          calendarId: 'primary-calendar',
          eventId: 'event-123',
          requestBody: objectMatching({
            description: 'Bring your documents',
          }),
        }),
      );
      expect(result).toEqual({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        eventId: 'event-123',
      });
    });

    it('returns the event id without a link when the calendar API fails', async () => {
      mockPatch.mockRejectedValue(new Error('invalid refresh token'));
      const service = await buildService(createConfigMock());

      const result = await service.updateInterviewEvent('event-123', {
        newStartTime: new Date('2026-09-01T10:00:00.000Z'),
      });

      expect(result).toEqual({ eventId: 'event-123' });
    });

    it('returns only the event id when no calendar client is configured', async () => {
      const service = await buildService(
        createConfigMock({
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
          GOOGLE_REFRESH_TOKEN: '',
        }),
      );

      const result = await service.updateInterviewEvent('event-123', {
        newStartTime: new Date('2026-09-01T10:00:00.000Z'),
      });

      expect(result).toEqual({ eventId: 'event-123' });
      expect(mockPatch).not.toHaveBeenCalled();
    });
  });

  describe('deleteInterviewEvent', () => {
    it('deletes the calendar event when configured', async () => {
      const service = await buildService(createConfigMock());

      await service.deleteInterviewEvent('event-123');

      expect(mockDelete).toHaveBeenCalledWith({
        calendarId: 'primary-calendar',
        eventId: 'event-123',
        sendUpdates: 'all',
      });
    });

    it('logs and does not throw when the delete fails', async () => {
      mockDelete.mockRejectedValue(new Error('invalid refresh token'));
      const service = await buildService(createConfigMock());

      await expect(
        service.deleteInterviewEvent('event-123'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when no calendar client is configured', async () => {
      const service = await buildService(
        createConfigMock({
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
          GOOGLE_REFRESH_TOKEN: '',
        }),
      );

      await service.deleteInterviewEvent('event-123');

      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
