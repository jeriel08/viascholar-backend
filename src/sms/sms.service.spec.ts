import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { SmsService, formatE164Phone } from './sms.service.js';

const createConfigMock = (
  overrides: Record<string, string | undefined> = {},
): { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn((key: string) => overrides[key]),
});

const createPrismaMock = () => ({
  auditLog: {
    findFirst: vi.fn(),
  },
});

describe('SmsService', () => {
  const buildService = async (
    config: ReturnType<typeof createConfigMock>,
    prisma: ReturnType<typeof createPrismaMock>,
  ) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    return module.get<SmsService>(SmsService);
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('formatE164Phone', () => {
    it('converts Philippine local numbers to E.164 format', () => {
      expect(formatE164Phone('0917 123 4567')).toBe('+639171234567');
      expect(formatE164Phone('9171234567')).toBe('+639171234567');
      expect(formatE164Phone('639171234567')).toBe('+639171234567');
      expect(formatE164Phone('+639171234567')).toBe('+639171234567');
    });
  });

  describe('sendOtpSms', () => {
    it('runs in simulation mode when TextBee credentials are not configured', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      const res = await service.sendOtpSms('0917 123 4567', {
        subscriberId: 'user_1',
        firstName: 'Juan',
        code: '123456',
        expiresInMinutes: 10,
      });

      expect(res).toEqual({ simulated: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to simulation mode when TEXTBEE_DEVICE_ID is missing', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const service = await buildService(
        createConfigMock({
          TEXTBEE_API_KEY: 'textbee-secret-key',
        }),
        createPrismaMock(),
      );

      const res = await service.sendOtpSms('0917 123 4567', {
        subscriberId: 'user_2',
        code: '111222',
        expiresInMinutes: 10,
      });

      expect(res).toEqual({ simulated: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('dispatches SMS via TextBee when TEXTBEE_API_KEY and TEXTBEE_DEVICE_ID are configured', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const service = await buildService(
        createConfigMock({
          TEXTBEE_API_KEY: 'textbee-secret-key',
          TEXTBEE_DEVICE_ID: 'device-123',
        }),
        createPrismaMock(),
      );

      const res = await service.sendOtpSms('0917 123 4567', {
        subscriberId: 'user_5',
        firstName: 'Juan',
        code: '654321',
        expiresInMinutes: 10,
        purpose: 'REGISTER',
      });

      expect(res).toEqual({ simulated: false });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.textbee.dev/api/v1/gateway/devices/device-123/send-sms',
        {
          method: 'POST',
          headers: {
            'x-api-key': 'textbee-secret-key',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipients: ['+639171234567'],
            message:
              'Your ViaScholar verification code is 654321. It expires in 10 minutes.',
          }),
        },
      );
    });

    it('falls back to simulation mode if the TextBee API returns an error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Gateway offline'),
      });
      vi.stubGlobal('fetch', fetchMock);
      const service = await buildService(
        createConfigMock({
          TEXTBEE_API_KEY: 'textbee-secret-key',
          TEXTBEE_DEVICE_ID: 'device-123',
        }),
        createPrismaMock(),
      );

      const res = await service.sendOtpSms('09171234567', {
        subscriberId: 'user_9',
        code: '999888',
        expiresInMinutes: 10,
      });

      expect(res).toEqual({ simulated: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendNotificationSms', () => {
    it('skips SMS notifications when smsNotifs is disabled', async () => {
      const prisma = createPrismaMock();
      prisma.auditLog.findFirst.mockResolvedValue({
        details: JSON.stringify({ smsNotifs: false }),
      });
      const service = await buildService(createConfigMock(), prisma);

      const res = await service.sendNotificationSms(
        7,
        '09171234567',
        'Disbursement released!',
      );

      expect(res).toEqual({ simulated: false, skipped: true });
    });

    it('dispatches SMS notification through TextBee when smsNotifs is enabled', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const prisma = createPrismaMock();
      prisma.auditLog.findFirst.mockResolvedValue({
        details: JSON.stringify({ smsNotifs: true }),
      });
      const service = await buildService(
        createConfigMock({
          TEXTBEE_API_KEY: 'textbee-secret-key',
          TEXTBEE_DEVICE_ID: 'device-123',
        }),
        prisma,
      );

      const res = await service.sendNotificationSms(
        7,
        '09171234567',
        'Disbursement released!',
      );

      expect(res).toEqual({ simulated: false });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.textbee.dev/api/v1/gateway/devices/device-123/send-sms',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            recipients: ['+639171234567'],
            message: 'Disbursement released!',
          }),
        }),
      );
    });
  });
});
