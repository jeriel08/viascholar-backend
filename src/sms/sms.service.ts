import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  USER_SETTINGS_AUDIT_ACTION,
  parseUserSettings,
} from '../auth/user-settings.util.js';

export function formatE164Phone(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return '';

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  if (hasPlus) {
    return `+${digits}`;
  }
  if (digits.startsWith('0') && digits.length === 11) {
    return `+63${digits.slice(1)}`;
  }
  if (digits.startsWith('63') && digits.length === 12) {
    return `+${digits}`;
  }
  if (digits.startsWith('9') && digits.length === 10) {
    return `+63${digits}`;
  }
  return `+${digits}`;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly apiKey: string | undefined;
  private readonly deviceId: string | undefined;
  private readonly apiUrl: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiKey = this.configService.get<string>('TEXTBEE_API_KEY')?.trim();
    this.deviceId = this.configService.get<string>('TEXTBEE_DEVICE_ID')?.trim();
    this.apiUrl = (
      this.configService.get<string>('TEXTBEE_API_URL')?.trim() ||
      'https://api.textbee.dev/api/v1'
    ).replace(/\/$/, '');

    if (this.apiKey && this.deviceId) {
      this.logger.log(
        `TextBee SMS service initialized (device: ${this.deviceId}).`,
      );
    } else {
      this.logger.warn(
        'TEXTBEE_API_KEY or TEXTBEE_DEVICE_ID not configured. Outgoing SMS messages will run in simulation mode.',
      );
    }
  }

  private async dispatchTextBeeSms(params: {
    subscriberId: string;
    phone: string;
    message: string;
  }): Promise<{ simulated: boolean }> {
    const formattedPhone = formatE164Phone(params.phone);
    if (!formattedPhone) {
      return { simulated: true };
    }

    if (!this.apiKey || !this.deviceId) {
      this.logger.log(
        `[SIMULATED TEXTBEE SMS] To: ${formattedPhone} | Subscriber: ${params.subscriberId} | Message: ${params.message}`,
      );
      return { simulated: true };
    }

    try {
      const response = await fetch(
        `${this.apiUrl}/gateway/devices/${encodeURIComponent(this.deviceId)}/send-sms`,
        {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipients: [formattedPhone],
            message: params.message,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.logger.error(
          `TextBee SMS send failed (${response.status}): ${errorText || response.statusText}`,
        );
        return { simulated: true };
      }

      this.logger.log(
        `TextBee SMS sent to ${formattedPhone} via device ${this.deviceId}.`,
      );
      return { simulated: false };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Exception sending TextBee SMS: ${msg}`);
      return { simulated: true };
    }
  }

  async sendOtpSms(
    phone: string,
    data: {
      subscriberId: string;
      firstName?: string;
      code: string;
      expiresInMinutes: number;
      purpose?: string;
    },
  ): Promise<{ simulated: boolean }> {
    const message = `Your ViaScholar verification code is ${data.code}. It expires in ${data.expiresInMinutes} minutes.`;
    return this.dispatchTextBeeSms({
      subscriberId: data.subscriberId,
      phone,
      message,
    });
  }

  async sendNotificationSms(
    userId: number,
    phone: string,
    message: string,
  ): Promise<{ simulated: boolean; skipped?: boolean }> {
    try {
      const pref = await this.prisma.auditLog?.findFirst?.({
        where: {
          user_id: userId,
          action: USER_SETTINGS_AUDIT_ACTION,
        },
        orderBy: { created_at: 'desc' },
      });
      if (!parseUserSettings(pref?.details).smsNotifs) {
        return { simulated: false, skipped: true };
      }
    } catch {
      return { simulated: false, skipped: true };
    }

    return this.dispatchTextBeeSms({
      subscriberId: `user_${userId}`,
      phone,
      message,
    });
  }
}
