import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { Test, TestingModule } from '@nestjs/testing';
import { ProfileService } from './profile.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { SmsService } from '../sms/sms.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';

const createPrismaMock = () => ({
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  scholarProfile: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  employee: {
    update: vi.fn(),
  },
  auditLog: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
});

const createCloudinaryMock = () => ({
  uploadImage: vi.fn(),
});

const createAuditMock = () => ({
  log: vi.fn(),
});

const createMailMock = () => ({
  sendTwoFactorOtpEmail: vi.fn().mockResolvedValue({ simulated: true }),
});

const createSmsMock = () => ({
  sendOtpSms: vi.fn().mockResolvedValue({ simulated: true }),
});

const makeScholarUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 1,
  email: 'scholar@example.com',
  password_hash: 'hashed-password',
  role: Role.SCHOLAR,
  is_active: true,
  scholar_profile: {
    profile_id: 10,
    user_id: 1,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    phone_number: '09171234567',
    student_number: '20250001',
  },
  employee: null,
  ...overrides,
});

const makeStaffUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 2,
  email: 'coordinator@example.com',
  password_hash: 'hashed-password',
  role: Role.COORDINATOR,
  is_active: true,
  scholar_profile: null,
  employee: {
    employee_id: 20,
    user_id: 2,
    first_name: 'Maria',
    last_name: 'Santos',
    title: 'Coordinator',
    department: 'Scholarships',
    bio: null,
    avatar_url: null,
    banner_url: null,
  },
  ...overrides,
});

describe('ProfileService', () => {
  let service: ProfileService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let cloudinary: ReturnType<typeof createCloudinaryMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let sms: ReturnType<typeof createSmsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    cloudinary = createCloudinaryMock();
    audit = createAuditMock();
    mail = createMailMock();
    sms = createSmsMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: SmsService, useValue: sms },
      ],
    }).compile();

    service = module.get<ProfileService>(ProfileService);
  });

  describe('updateProfile', () => {
    it('throws NotFoundException when the user account does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProfile(999, { first_name: 'Ghost' }),
      ).rejects.toThrow(new NotFoundException('User account not found.'));

      expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
      expect(prisma.employee.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects a phone number owned by another scholar profile', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.scholarProfile.findFirst.mockResolvedValue({ profile_id: 99 });

      await expect(
        service.updateProfile(1, { phone_number: '09179999999' }),
      ).rejects.toThrow(
        new ConflictException(
          'Phone number is already in use by another profile.',
        ),
      );

      expect(prisma.scholarProfile.findFirst).toHaveBeenCalledWith({
        where: {
          phone_number: '09179999999',
          profile_id: { not: 10 },
        },
      });
      expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
    });

    it('rejects a student number owned by another scholar profile', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.scholarProfile.findFirst.mockResolvedValue({ profile_id: 88 });

      await expect(
        service.updateProfile(1, { student_number: '20259999' }),
      ).rejects.toThrow(
        new ConflictException(
          'Student number is already in use by another scholar.',
        ),
      );

      expect(prisma.scholarProfile.findFirst).toHaveBeenCalledWith({
        where: {
          student_number: '20259999',
          profile_id: { not: 10 },
        },
      });
      expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
    });

    it('updates the scholar profile and strips the password hash from the response', async () => {
      const user = makeScholarUser();
      const updatedUser = makeScholarUser({
        scholar_profile: {
          ...user.scholar_profile,
          first_name: 'Juan Miguel',
          student_number: '20251234',
          bio: 'Updated bio',
        },
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(updatedUser);
      prisma.scholarProfile.findFirst.mockResolvedValue(null);
      prisma.scholarProfile.update.mockResolvedValue(
        updatedUser.scholar_profile,
      );

      const dto: UpdateProfileDto = {
        first_name: 'Juan Miguel',
        last_name: 'Dela Cruz',
        phone_number: '09171234567',
        student_number: '20251234',
        student_address: 'Davao City',
        school_address: 'UM Matina',
        bio: 'Updated bio',
        course_of_study: 'BS Information Technology',
        school_name: 'University of Mindanao',
        current_year_level: 3,
        scholarship_track: 'Academic',
      };

      const result = await service.updateProfile(1, dto);

      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 10 },
        data: {
          first_name: 'Juan Miguel',
          last_name: 'Dela Cruz',
          phone_number: '09171234567',
          student_address: 'Davao City',
          school_address: 'UM Matina',
          student_number: '20251234',
          bio: 'Updated bio',
          avatar_url: undefined,
          banner_url: undefined,
          course_of_study: 'BS Information Technology',
          school_name: 'University of Mindanao',
          current_year_level: 3,
          scholarship_track: 'Academic',
        },
      });
      expect(prisma.employee.update).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'PROFILE_UPDATED',
        'User (ID: 1) updated their profile',
      );
      expect(result).not.toHaveProperty('password_hash');
      expect(result.scholar_profile).toMatchObject({
        first_name: 'Juan Miguel',
        student_number: '20251234',
      });
    });

    it('updates the employee profile for staff accounts', async () => {
      const user = makeStaffUser();
      const updatedUser = makeStaffUser({
        employee: {
          ...user.employee,
          first_name: 'Maria Clara',
          bio: 'Scholarship lead',
          title: 'Senior Coordinator',
        },
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(updatedUser);
      prisma.employee.update.mockResolvedValue(updatedUser.employee);

      const dto: UpdateProfileDto = {
        first_name: 'Maria Clara',
        last_name: 'Santos',
        bio: 'Scholarship lead',
        title: 'Senior Coordinator',
        department: 'Scholarships',
      };

      const result = await service.updateProfile(2, dto);

      expect(prisma.employee.update).toHaveBeenCalledWith({
        where: { employee_id: 20 },
        data: {
          first_name: 'Maria Clara',
          last_name: 'Santos',
          bio: 'Scholarship lead',
          avatar_url: undefined,
          banner_url: undefined,
          title: 'Senior Coordinator',
          department: 'Scholarships',
        },
      });
      expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('password_hash');
      expect(result.employee).toMatchObject({
        first_name: 'Maria Clara',
        title: 'Senior Coordinator',
      });
    });

    it('throws when the refreshed user record disappears', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeScholarUser())
        .mockResolvedValueOnce(null);
      prisma.scholarProfile.findFirst.mockResolvedValue(null);
      prisma.scholarProfile.update.mockResolvedValue({});

      await expect(
        service.updateProfile(1, { first_name: 'Juan' }),
      ).rejects.toThrow(
        new NotFoundException('Updated user record not found.'),
      );

      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('uploadAvatar', () => {
    it('uploads to the avatars folder and persists the secure URL', async () => {
      const file = {
        originalname: 'avatar.png',
      } as unknown as Express.Multer.File;
      cloudinary.uploadImage.mockResolvedValue({
        secure_url: 'https://cdn.test/avatars/user-1.png',
      });
      const updatedProfile = { user_id: 1 } as Awaited<
        ReturnType<ProfileService['updateProfile']>
      >;
      const updateSpy = vi
        .spyOn(service, 'updateProfile')
        .mockResolvedValue(updatedProfile);

      const result = await service.uploadAvatar(1, file);

      expect(cloudinary.uploadImage).toHaveBeenCalledWith(
        file,
        'viascholar/avatars',
      );
      expect(updateSpy).toHaveBeenCalledWith(1, {
        avatar_url: 'https://cdn.test/avatars/user-1.png',
      });
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'AVATAR_UPLOADED',
        'User (ID: 1) uploaded a new avatar',
      );
      expect(result).toBe(updatedProfile);
    });
  });

  describe('uploadBanner', () => {
    it('uploads to the banners folder and persists the secure URL', async () => {
      const file = {
        originalname: 'banner.png',
      } as unknown as Express.Multer.File;
      cloudinary.uploadImage.mockResolvedValue({
        secure_url: 'https://cdn.test/banners/user-1.png',
      });
      const updatedProfile = { user_id: 1 } as Awaited<
        ReturnType<ProfileService['updateProfile']>
      >;
      const updateSpy = vi
        .spyOn(service, 'updateProfile')
        .mockResolvedValue(updatedProfile);

      const result = await service.uploadBanner(1, file);

      expect(cloudinary.uploadImage).toHaveBeenCalledWith(
        file,
        'viascholar/banners',
      );
      expect(updateSpy).toHaveBeenCalledWith(1, {
        banner_url: 'https://cdn.test/banners/user-1.png',
      });
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'BANNER_UPLOADED',
        'User (ID: 1) uploaded a new banner',
      );
      expect(result).toBe(updatedProfile);
    });
  });

  describe('getUserSettings', () => {
    it('throws NotFoundException when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUserSettings(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns default settings when no saved preferences exist', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const result = await service.getUserSettings(1);

      expect(result).toEqual({
        emailNotifs: true,
        smsNotifs: false,
        forumDigest: true,
        twoFactor: true,
        twoFactorMethod: 'EMAIL_OTP',
        emailVerified: false,
        phoneVerified: false,
        publicProfile: true,
        passwordChangedAt: null,
      });
    });

    it('merges saved preference fields with defaults', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 50,
        details: JSON.stringify({
          emailNotifs: false,
          smsNotifs: true,
          twoFactor: true,
          twoFactorMethod: 'EMAIL_OTP',
          twoFactorSecret: 'SHOULD_BE_STRIPPED',
        }),
      });

      const result = await service.getUserSettings(1);

      expect(result).toEqual({
        emailNotifs: false,
        smsNotifs: true,
        forumDigest: true,
        twoFactor: true,
        twoFactorMethod: 'EMAIL_OTP',
        emailVerified: false,
        phoneVerified: false,
        publicProfile: true,
        passwordChangedAt: null,
      });
    });
  });

  describe('updateUserSettings', () => {
    it('creates a preferences entry when none exists yet', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const result = await service.updateUserSettings(1, {
        emailNotifs: false,
        forumDigest: false,
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          user_id: 1,
          action: 'USER_SETTINGS_PREFERENCES',
          details: JSON.stringify({
            emailNotifs: false,
            smsNotifs: false,
            forumDigest: false,
            twoFactor: true,
            twoFactorMethod: 'EMAIL_OTP',
            emailVerified: false,
            phoneVerified: false,
            publicProfile: true,
            passwordChangedAt: null,
          }),
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'USER_SETTINGS_UPDATED',
        'User (ID: 1) updated settings: emailNotifs=false, forumDigest=false',
      );
      expect(result).toEqual({
        emailNotifs: false,
        smsNotifs: false,
        forumDigest: false,
        twoFactor: true,
        twoFactorMethod: 'EMAIL_OTP',
        emailVerified: false,
        phoneVerified: false,
        publicProfile: true,
        passwordChangedAt: null,
      });
    });

    it('updates the existing preferences row and preserves unchanged fields', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 77,
        details: JSON.stringify({
          emailNotifs: false,
          smsNotifs: true,
          forumDigest: true,
          twoFactor: false,
          publicProfile: true,
        }),
      });

      const result = await service.updateUserSettings(1, {
        forumDigest: false,
      });

      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { log_id: 77 },
        data: {
          details: JSON.stringify({
            emailNotifs: false,
            smsNotifs: true,
            forumDigest: false,
            twoFactor: false,
            twoFactorMethod: null,
            emailVerified: false,
            phoneVerified: false,
            publicProfile: true,
            passwordChangedAt: null,
            twoFactorSecret: null,
            pendingTwoFactor: null,
            pendingContactVerification: null,
          }),
        },
      });
      expect(result.emailNotifs).toBe(false);
      expect(result.smsNotifs).toBe(true);
      expect(result.forumDigest).toBe(false);
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'USER_SETTINGS_UPDATED',
        'User (ID: 1) updated settings: forumDigest=false',
      );
    });

    it('clears 2FA method and secret and logs when disabling 2FA', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 80,
        details: JSON.stringify({
          twoFactor: true,
          twoFactorMethod: 'AUTHENTICATOR_APP',
          twoFactorSecret: 'JBSWY3DPEHPK3PXP',
        }),
      });

      const result = await service.updateUserSettings(1, { twoFactor: false });

      expect(result.twoFactor).toBe(false);
      expect(result.twoFactorMethod).toBeNull();
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'TWO_FACTOR_DISABLED',
        'User (ID: 1) disabled two-factor authentication',
      );
    });

    it('rejects enabling smsNotifs when phoneVerified is false and allows it when phoneVerified is true', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValueOnce({
        log_id: 81,
        details: JSON.stringify({ phoneVerified: false, smsNotifs: false }),
      });

      await expect(
        service.updateUserSettings(1, { smsNotifs: true }),
      ).rejects.toThrow(
        new BadRequestException(
          'Please verify your phone number before enabling SMS notifications.',
        ),
      );
      expect(prisma.auditLog.update).not.toHaveBeenCalled();

      prisma.auditLog.findFirst.mockResolvedValueOnce({
        log_id: 81,
        details: JSON.stringify({ phoneVerified: true, smsNotifs: false }),
      });

      const updated = await service.updateUserSettings(1, { smsNotifs: true });

      expect(updated.smsNotifs).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'USER_SETTINGS_UPDATED',
        'User (ID: 1) updated settings: smsNotifs=true',
      );
    });
  });

  describe('two-factor setup and verification', () => {
    it('initiates Email OTP setup and sends the verification email', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const res = await service.initiateTwoFactorSetup(1, {
        method: 'EMAIL_OTP',
      });

      expect(res.method).toBe('EMAIL_OTP');
      expect(res.destination).toBe('scholar@example.com');
      const sentEmailCode = (
        mail.sendTwoFactorOtpEmail.mock.calls[0][1] as { code: string }
      ).code;
      expect(sentEmailCode).toMatch(/^\d{6}$/);
      expect(mail.sendTwoFactorOtpEmail).toHaveBeenCalledWith(
        'scholar@example.com',
        {
          userName: 'Juan',
          code: sentEmailCode,
          expiresInMinutes: 10,
        },
      );
    });

    it('rejects SMS OTP setup when scholar has no phone number', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({
          scholar_profile: {
            profile_id: 10,
            user_id: 1,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
            phone_number: '',
          },
        }),
      );

      await expect(
        service.initiateTwoFactorSetup(1, { method: 'SMS_OTP' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('initiates SMS OTP setup when a phone number is present', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const res = await service.initiateTwoFactorSetup(1, {
        method: 'SMS_OTP',
      });

      expect(res.method).toBe('SMS_OTP');
      expect(res.destination).toBe('09171234567');
      const sentSmsCode = (sms.sendOtpSms.mock.calls[0][1] as { code: string })
        .code;
      expect(sentSmsCode).toMatch(/^\d{6}$/);
      expect(sms.sendOtpSms).toHaveBeenCalledWith('09171234567', {
        subscriberId: 'user_1',
        firstName: 'Juan',
        code: sentSmsCode,
        expiresInMinutes: 10,
        purpose: 'TWO_FACTOR_SETUP',
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('generates a QR code and verifies Authenticator App TOTP setup', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const setupRes = await service.initiateTwoFactorSetup(1, {
        method: 'AUTHENTICATOR_APP',
      });

      expect(setupRes.method).toBe('AUTHENTICATOR_APP');
      expect(setupRes.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(setupRes.manualKey).toMatch(/^[A-Z2-7]+$/);

      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = 0;
      let val = 0;
      const bytes: number[] = [];
      for (const ch of setupRes.manualKey ?? '') {
        val = (val << 5) | alphabet.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
          bytes.push((val >>> (bits - 8)) & 255);
          bits -= 8;
        }
      }
      const counter = Math.floor(Date.now() / 1000 / 30);
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(BigInt(counter));
      const hmac = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
      const offset = hmac[hmac.length - 1] & 0x0f;
      const totp = String(
        (((hmac[offset] & 0x7f) << 24) |
          ((hmac[offset + 1] & 0xff) << 16) |
          ((hmac[offset + 2] & 0xff) << 8) |
          (hmac[offset + 3] & 0xff)) %
          1_000_000,
      ).padStart(6, '0');

      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 91,
        details: JSON.stringify({
          pendingTwoFactor: {
            method: 'AUTHENTICATOR_APP',
            secret: setupRes.manualKey,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });

      const verified = await service.verifyTwoFactorSetup(1, {
        method: 'AUTHENTICATOR_APP',
        code: totp,
      });

      expect(verified.twoFactor).toBe(true);
      expect(verified.twoFactorMethod).toBe('AUTHENTICATOR_APP');
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'TWO_FACTOR_ENABLED',
        'User (ID: 1) enabled two-factor authentication (AUTHENTICATOR_APP)',
      );
    });

    it('rejects expired or mismatched OTP codes during verification', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 92,
        details: JSON.stringify({
          pendingTwoFactor: {
            method: 'EMAIL_OTP',
            code: '123456',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });

      await expect(
        service.verifyTwoFactorSetup(1, {
          method: 'EMAIL_OTP',
          code: '999999',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('changePassword', () => {
    it('rejects incorrect current password', async () => {
      const hash = await bcrypt.hash('CorrectPass1!', 10);
      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({ password_hash: hash }),
      );

      await expect(
        service.changePassword(1, {
          current_password: 'WrongPassword1!',
          new_password: 'NewPassword2@',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates password hash, stores passwordChangedAt, and logs an audit entry', async () => {
      const hash = await bcrypt.hash('OldPassword1!', 10);
      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({ password_hash: hash }),
      );
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const res = await service.changePassword(1, {
        current_password: 'OldPassword1!',
        new_password: 'NewPassword2@',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { user_id: 1 },
        data: { password_hash: expect.any(String) as string },
      });
      expect(res.passwordChangedAt).toEqual(expect.any(String));
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'PASSWORD_CHANGED',
        'User (ID: 1) changed their account password',
      );
    });
  });

  describe('contact verification', () => {
    it('sends an email verification code and marks emailVerified on verification', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const setupRes = await service.initiateContactVerification(1, {
        channel: 'EMAIL',
      });

      expect(setupRes.channel).toBe('EMAIL');
      expect(setupRes.destination).toBe('scholar@example.com');
      const sentEmailCode = (
        mail.sendTwoFactorOtpEmail.mock.calls[0][1] as { code: string }
      ).code;
      expect(sentEmailCode).toMatch(/^\d{6}$/);
      expect(mail.sendTwoFactorOtpEmail).toHaveBeenCalledWith(
        'scholar@example.com',
        {
          userName: 'Juan',
          code: sentEmailCode,
          expiresInMinutes: 10,
        },
      );

      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 95,
        details: JSON.stringify({
          pendingContactVerification: {
            channel: 'EMAIL',
            code: sentEmailCode,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });

      const verified = await service.verifyContactVerification(1, {
        channel: 'EMAIL',
        code: sentEmailCode,
      });

      expect(verified.emailVerified).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'EMAIL_VERIFIED',
        'User (ID: 1) verified their email address',
      );
    });

    it('rejects phone verification when no phone number exists and sends SMS via SmsService when present', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({
          scholar_profile: {
            profile_id: 10,
            user_id: 1,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
            phone_number: '',
          },
        }),
      );

      await expect(
        service.initiateContactVerification(1, { channel: 'PHONE' }),
      ).rejects.toThrow(BadRequestException);

      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const smsRes = await service.initiateContactVerification(1, {
        channel: 'PHONE',
      });

      expect(smsRes.channel).toBe('PHONE');
      expect(smsRes.destination).toBe('09171234567');
      const sentSmsCode = (sms.sendOtpSms.mock.calls[0][1] as { code: string })
        .code;
      expect(sentSmsCode).toMatch(/^\d{6}$/);
      expect(sms.sendOtpSms).toHaveBeenCalledWith('09171234567', {
        subscriberId: 'user_1',
        firstName: 'Juan',
        code: sentSmsCode,
        expiresInMinutes: 10,
        purpose: 'PHONE_VERIFICATION',
      });

      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 96,
        details: JSON.stringify({
          pendingContactVerification: {
            channel: 'PHONE',
            code: sentSmsCode,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });

      const verified = await service.verifyContactVerification(1, {
        channel: 'PHONE',
        code: sentSmsCode,
      });

      expect(verified.phoneVerified).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'PHONE_VERIFIED',
        'User (ID: 1) verified their phone number',
      );
    });

    it('rejects invalid contact verification codes and resets phoneVerified when phone changes', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 97,
        details: JSON.stringify({
          pendingContactVerification: {
            channel: 'PHONE',
            code: '123456',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });

      await expect(
        service.verifyContactVerification(1, {
          channel: 'PHONE',
          code: '000000',
        }),
      ).rejects.toThrow(BadRequestException);

      const scholar = makeScholarUser();
      const updatedScholar = makeScholarUser({
        scholar_profile: {
          ...scholar.scholar_profile,
          phone_number: '09998887777',
        },
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(scholar)
        .mockResolvedValueOnce(updatedScholar);
      prisma.scholarProfile.findFirst.mockResolvedValue(null);
      prisma.scholarProfile.update.mockResolvedValue(
        updatedScholar.scholar_profile,
      );
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 98,
        details: JSON.stringify({ phoneVerified: true, smsNotifs: true }),
      });

      await service.updateProfile(1, { phone_number: '09998887777' });

      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { log_id: 98 },
        data: {
          details: expect.stringContaining('"phoneVerified":false') as string,
        },
      });
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { log_id: 98 },
        data: {
          details: expect.stringContaining('"smsNotifs":false') as string,
        },
      });
    });
  });

  describe('deactivateAccount', () => {
    it('sets user is_active to false without archiving and records audit entry with reason', async () => {
      prisma.user.findUnique.mockResolvedValue(makeScholarUser());
      prisma.user.update.mockResolvedValue(
        makeScholarUser({ is_active: false }),
      );

      const res = await service.deactivateAccount(1, {
        reason: 'Taking a break',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { user_id: 1 },
        data: { is_active: false },
      });
      expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'ACCOUNT_DEACTIVATED',
        'User (ID: 1) deactivated their account (Reason: Taking a break)',
      );
      expect(res).toEqual({
        message: 'Your account has been deactivated.',
      });
    });

    it('validates optional password and throws NotFoundException when user is missing', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(service.deactivateAccount(999)).rejects.toThrow(
        NotFoundException,
      );

      const passwordHash = await bcrypt.hash('CorrectPassword1!', 10);
      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({ password_hash: passwordHash }),
      );

      await expect(
        service.deactivateAccount(1, { password: 'WrongPassword!' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('schema column persistence and optional profile fields', () => {
    it('normalizes and persists middle_name, suffix, and sex for scholar and staff updates', async () => {
      const scholar = makeScholarUser();
      prisma.user.findUnique
        .mockResolvedValueOnce(scholar)
        .mockResolvedValueOnce(scholar);
      prisma.scholarProfile.update.mockResolvedValue(scholar.scholar_profile);

      await service.updateProfile(1, {
        first_name: 'Juan',
        middle_name: '  Reyes  ',
        last_name: 'Dela Cruz',
        suffix: '   ',
        sex: 'Male',
      });

      const scholarUpdateArgs = prisma.scholarProfile.update.mock
        .calls[0]?.[0] as {
        where: { profile_id: number };
        data: Record<string, unknown>;
      };
      expect(scholarUpdateArgs.where).toEqual({ profile_id: 10 });
      expect(scholarUpdateArgs.data).toMatchObject({
        first_name: 'Juan',
        middle_name: 'Reyes',
        last_name: 'Dela Cruz',
        suffix: null,
        sex: 'Male',
      });

      const staff = makeStaffUser();
      prisma.user.findUnique
        .mockResolvedValueOnce(staff)
        .mockResolvedValueOnce(staff);
      prisma.employee.update.mockResolvedValue(staff.employee);

      await service.updateProfile(2, {
        first_name: 'Maria',
        middle_name: '',
        last_name: 'Santos',
        suffix: 'PhD',
        sex: 'Female',
      });

      const staffUpdateArgs = prisma.employee.update.mock.calls[0]?.[0] as {
        where: { employee_id: number };
        data: Record<string, unknown>;
      };
      expect(staffUpdateArgs.where).toEqual({ employee_id: 20 });
      expect(staffUpdateArgs.data).toMatchObject({
        first_name: 'Maria',
        middle_name: null,
        last_name: 'Santos',
        suffix: 'PhD',
        sex: 'Female',
      });
    });

    it('reads settings from User/ScholarProfile columns and syncs columns on update and phone verification', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({
          is_email_verified: true,
          two_factor_enabled: true,
          two_factor_method: 'SMS_OTP',
          email_notifs: false,
          sms_notifs: true,
          forum_digest: false,
          public_profile: false,
          scholar_profile: {
            profile_id: 10,
            user_id: 1,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
            phone_number: '09171234567',
            is_phone_verified: true,
          },
        }),
      );
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const loaded = await service.getUserSettings(1);
      expect(loaded).toEqual({
        emailNotifs: false,
        smsNotifs: true,
        forumDigest: false,
        twoFactor: true,
        twoFactorMethod: 'SMS_OTP',
        emailVerified: true,
        phoneVerified: true,
        publicProfile: false,
        passwordChangedAt: null,
      });

      prisma.user.findUnique.mockResolvedValue(
        makeScholarUser({
          is_email_verified: false,
          two_factor_enabled: true,
          two_factor_method: 'EMAIL_OTP',
          email_notifs: true,
          sms_notifs: false,
          forum_digest: true,
          public_profile: true,
          scholar_profile: {
            profile_id: 10,
            user_id: 1,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
            phone_number: '09171234567',
            is_phone_verified: true,
          },
        }),
      );
      prisma.auditLog.findFirst.mockResolvedValue({
        log_id: 50,
        details: JSON.stringify({
          pendingContactVerification: {
            channel: 'PHONE',
            code: '654321',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });

      await service.updateUserSettings(1, {
        publicProfile: false,
        emailNotifs: false,
      });

      const settingsUpdateArgs = prisma.user.update.mock.calls[0]?.[0] as {
        where: { user_id: number };
        data: Record<string, unknown>;
      };
      expect(settingsUpdateArgs.where).toEqual({ user_id: 1 });
      expect(settingsUpdateArgs.data).toMatchObject({
        public_profile: false,
        email_notifs: false,
      });

      await service.verifyContactVerification(1, {
        channel: 'PHONE',
        code: '654321',
      });

      expect(prisma.scholarProfile.updateMany).toHaveBeenCalledWith({
        where: { user_id: 1 },
        data: {
          is_phone_verified: true,
          phone_verified_at: expect.any(Date) as Date,
        },
      });
    });
  });
});
