import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProfileService } from './profile.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';

const createPrismaMock = () => ({
  user: {
    findUnique: vi.fn(),
  },
  scholarProfile: {
    findFirst: vi.fn(),
    update: vi.fn(),
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

  beforeEach(async () => {
    prisma = createPrismaMock();
    cloudinary = createCloudinaryMock();
    audit = createAuditMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: AuditService, useValue: audit },
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
        twoFactor: false,
        publicProfile: true,
      });
    });

    it('merges saved preference fields with defaults', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue({
        audit_log_id: 50,
        details: JSON.stringify({ emailNotifs: false, smsNotifs: true }),
      });

      const result = await service.getUserSettings(1);

      expect(result).toEqual({
        emailNotifs: false,
        smsNotifs: true,
        forumDigest: true,
        twoFactor: false,
        publicProfile: true,
      });
    });
  });

  describe('updateUserSettings', () => {
    it('creates a preferences entry when none exists yet', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 1 });
      prisma.auditLog.findFirst.mockResolvedValue(null);

      const result = await service.updateUserSettings(1, {
        smsNotifs: true,
        forumDigest: false,
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          user_id: 1,
          action: 'USER_SETTINGS_PREFERENCES',
          details: JSON.stringify({
            emailNotifs: true,
            smsNotifs: true,
            forumDigest: false,
            twoFactor: false,
            publicProfile: true,
          }),
        },
      });
      expect(audit.log).not.toHaveBeenCalled();
      expect(result).toEqual({
        emailNotifs: true,
        smsNotifs: true,
        forumDigest: false,
        twoFactor: false,
        publicProfile: true,
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
            publicProfile: true,
          }),
        },
      });
      expect(result.emailNotifs).toBe(false);
      expect(result.smsNotifs).toBe(true);
      expect(result.forumDigest).toBe(false);
    });
  });
});
