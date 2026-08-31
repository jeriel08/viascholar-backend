import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { randomUUID } from 'crypto';

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private calendar: any = null;
  private isConfigured = false;

  constructor(private configService: ConfigService) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const refreshToken = this.configService.get<string>('GOOGLE_REFRESH_TOKEN');

    if (clientId && clientSecret && refreshToken) {
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      this.isConfigured = true;
      this.logger.log('Google Calendar API service initialized with OAuth2.');
    } else {
      this.logger.warn(
        'Google Calendar OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) not set. Fallback Meet links will be generated for development.',
      );
    }
  }

  async createInterviewEvent(params: {
    title: string;
    description?: string;
    startTime: Date;
    durationMinutes?: number;
    attendeeEmails: string[];
    manualLink?: string;
  }): Promise<{ meetingUrl: string; eventId?: string }> {
    if (params.manualLink) {
      return { meetingUrl: params.manualLink };
    }

    const duration = params.durationMinutes || 45;
    const endTime = new Date(params.startTime.getTime() + duration * 60 * 1000);

    if (this.isConfigured && this.calendar) {
      try {
        const calendarId =
          this.configService.get<string>('GOOGLE_CALENDAR_ID') || 'primary';

        const event = await this.calendar.events.insert({
          calendarId,
          conferenceDataVersion: 1,
          sendUpdates: 'all',
          requestBody: {
            summary: params.title,
            description: params.description,
            start: { dateTime: params.startTime.toISOString() },
            end: { dateTime: endTime.toISOString() },
            attendees: params.attendeeEmails
              .filter((e) => Boolean(e))
              .map((email) => ({ email })),
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          },
        });

        const meetingUrl =
          event.data.hangoutLink ||
          event.data.conferenceData?.entryPoints?.find(
            (ep: any) => ep.entryPointType === 'video',
          )?.uri;

        return {
          meetingUrl: meetingUrl || 'https://meet.google.com/new',
          eventId: event.data.id,
        };
      } catch (error: any) {
        this.logger.error(
          `Failed to create Google Calendar event: ${error?.message || error}`,
          error?.stack,
        );
      }
    }

    // Graceful fallback URL generator when Google Calendar credentials are not configured or offline
    const randomPart1 = Math.random().toString(36).substring(2, 5);
    const randomPart2 = Math.random().toString(36).substring(2, 6);
    const randomPart3 = Math.random().toString(36).substring(2, 5);
    return {
      meetingUrl: `https://meet.google.com/${randomPart1}-${randomPart2}-${randomPart3}`,
    };
  }

  async updateInterviewEvent(
    eventId: string,
    params: {
      newStartTime: Date;
      durationMinutes?: number;
      notes?: string;
      manualLink?: string;
    },
  ): Promise<{ meetingUrl?: string; eventId?: string }> {
    if (params.manualLink) {
      return { meetingUrl: params.manualLink, eventId };
    }

    if (this.isConfigured && this.calendar && eventId) {
      try {
        const calendarId =
          this.configService.get<string>('GOOGLE_CALENDAR_ID') || 'primary';
        const duration = params.durationMinutes || 45;
        const endTime = new Date(
          params.newStartTime.getTime() + duration * 60 * 1000,
        );

        const event = await this.calendar.events.patch({
          calendarId,
          eventId,
          sendUpdates: 'all',
          requestBody: {
            start: { dateTime: params.newStartTime.toISOString() },
            end: { dateTime: endTime.toISOString() },
            description: params.notes,
          },
        });

        const meetingUrl =
          event.data.hangoutLink ||
          event.data.conferenceData?.entryPoints?.find(
            (ep: any) => ep.entryPointType === 'video',
          )?.uri;

        return {
          meetingUrl: meetingUrl,
          eventId: event.data.id,
        };
      } catch (error: any) {
        this.logger.error(
          `Failed to update Google Calendar event ${eventId}: ${error?.message || error}`,
        );
      }
    }

    return { eventId };
  }

  async deleteInterviewEvent(eventId: string): Promise<void> {
    if (this.isConfigured && this.calendar && eventId) {
      try {
        const calendarId =
          this.configService.get<string>('GOOGLE_CALENDAR_ID') || 'primary';
        await this.calendar.events.delete({
          calendarId,
          eventId,
          sendUpdates: 'all',
        });
      } catch (error: any) {
        this.logger.error(
          `Failed to delete Google Calendar event ${eventId}: ${error?.message || error}`,
        );
      }
    }
  }
}
