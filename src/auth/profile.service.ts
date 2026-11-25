import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { SmsService } from '../sms/sms.service.js';
import { jwtUserCacheKey } from './strategies/jwt.strategy.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { UpdateUserSettingsDto } from './dto/update-user-settings.dto.js';
import { SetupTwoFactorDto, VerifyTwoFactorDto } from './dto/two-factor.dto.js';
import {
  SendContactVerificationDto,
  VerifyContactVerificationDto,
} from './dto/contact-verification.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { DeactivateAccountDto } from './dto/deactivate-account.dto.js';
import { generateBase32Secret, verifyTotpCode } from './mfa-token.util.js';
import {
  type PendingContactVerification,
  type PendingTwoFactorSetup,
  type StoredUserSettingsRecord,
  type TwoFactorMethod,
  USER_SETTINGS_AUDIT_ACTION,
  type UserSettings,
  type UserSettingsColumnSource,
  mergeUserColumnsIntoSettings,
  parseStoredUserSettings,
  stripInternalSettings,
} from './user-settings.util.js';

export interface TwoFactorSetupResponse {
  method: TwoFactorMethod;
  destination: string;
  expiresInMinutes: number;
  qrCodeDataUrl?: string;
  manualKey?: string;
  simulated?: boolean;
}

export interface ContactVerificationSetupResponse {
  channel: 'EMAIL' | 'PHONE';
  destination: string;
  expiresInMinutes: number;
  simulated?: boolean;
}

export interface PublicScholarRecentPost {
  post_id: number;
  title: string;
  category: string | null;
  views_count: number;
  comments_count: number;
  created_at: Date;
}

export interface PublicScholarProfile {
  user_id: number;
  is_public: boolean;
  is_self: boolean;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  suffix: string | null;
  gender: string | null;
  email: string;
  bio: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  school_name: string | null;
  course_of_study: string | null;
  current_year_level: number | null;
  scholarship_track: string | null;
  member_since: Date;
  forum_posts_count: number;
  forum_comments_count: number;
  recent_posts: PublicScholarRecentPost[];
}

@Injectable()
export class ProfileService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private auditService: AuditService,
    private mailService: MailService,
    @Optional() private smsService?: SmsService,
    @Optional() private cacheService?: AppCacheService,
  ) {}

  // Method to handle Avatar upload
  async uploadAvatar(userId: number, file: Express.Multer.File) {
    const result = await this.cloudinaryService.uploadImage(
      file,
      'viascholar/avatars',
    );
    const imageUrl = result.secure_url;

    // Save the URL to user's profile
    const updated = await this.updateProfile(userId, { avatar_url: imageUrl });

    await this.auditService.log(
      userId,
      'AVATAR_UPLOADED',
      `User (ID: ${userId}) uploaded a new avatar`,
    );

    return updated;
  }

  // Method to handle Banner upload
  async uploadBanner(userId: number, file: Express.Multer.File) {
    const result = await this.cloudinaryService.uploadImage(
      file,
      'viascholar/banners',
    );
    const imageUrl = result.secure_url;

    // Save the URL to user's profile
    const updated = await this.updateProfile(userId, { banner_url: imageUrl });

    await this.auditService.log(
      userId,
      'BANNER_UPLOADED',
      `User (ID: ${userId}) uploaded a new banner`,
    );

    return updated;
  }

  // Update User Profile (Scholar or Staff)
  async updateProfile(userId: number, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new NotFoundException('User account not found.');
    }

    // 1. If User is an Applicant or Scholar, update scholar_profiles table
    const studentRoles: Role[] = [Role.APPLICANT, Role.SCHOLAR];
    if (studentRoles.includes(user.role) && user.scholar_profile) {
      if (dto.phone_number) {
        const duplicatePhone = await this.prisma.scholarProfile.findFirst({
          where: {
            phone_number: dto.phone_number,
            profile_id: { not: user.scholar_profile.profile_id },
          },
        });
        if (duplicatePhone) {
          throw new ConflictException(
            'Phone number is already in use by another profile.',
          );
        }
      }

      if (dto.student_number) {
        const duplicateStudentNum = await this.prisma.scholarProfile.findFirst({
          where: {
            student_number: dto.student_number,
            profile_id: { not: user.scholar_profile.profile_id },
          },
        });
        if (duplicateStudentNum) {
          throw new ConflictException(
            'Student number is already in use by another scholar.',
          );
        }
      }

      await this.prisma.scholarProfile.update({
        where: { profile_id: user.scholar_profile.profile_id },
        data: {
          first_name: dto.first_name,
          ...(dto.middle_name !== undefined
            ? { middle_name: dto.middle_name.trim() || null }
            : {}),
          last_name: dto.last_name,
          ...(dto.suffix !== undefined
            ? { suffix: dto.suffix.trim() || null }
            : {}),
          ...(dto.gender !== undefined
            ? { gender: dto.gender.trim() || null }
            : {}),
          phone_number: dto.phone_number,
          student_address: dto.student_address,
          school_address: dto.school_address,
          student_number: dto.student_number,
          bio: dto.bio,
          avatar_url: dto.avatar_url,
          banner_url: dto.banner_url,
          course_of_study: dto.course_of_study,
          school_name: dto.school_name,
          current_year_level: dto.current_year_level,
          scholarship_track: dto.scholarship_track,
        },
      });

      if (
        dto.phone_number !== undefined &&
        dto.phone_number.trim() !==
          (user.scholar_profile.phone_number ?? '').trim()
      ) {
        const existingSettings =
          typeof this.prisma.auditLog?.findFirst === 'function'
            ? await this.findLatestSettingsRecord(userId)
            : null;
        const currentSettings = mergeUserColumnsIntoSettings(
          user,
          parseStoredUserSettings(existingSettings?.details),
        );
        if (currentSettings.phoneVerified || currentSettings.smsNotifs) {
          await this.persistStoredSettings(
            userId,
            { ...currentSettings, phoneVerified: false, smsNotifs: false },
            existingSettings?.log_id,
            { phoneVerifiedAt: null },
          );
        }
      }
    }
    // 2. If User is Staff (Coordinator / Grantor / Admin), update employees table
    else if (user.employee) {
      await this.prisma.employee.update({
        where: { employee_id: user.employee.employee_id },
        data: {
          first_name: dto.first_name,
          ...(dto.middle_name !== undefined
            ? { middle_name: dto.middle_name.trim() || null }
            : {}),
          last_name: dto.last_name,
          ...(dto.suffix !== undefined
            ? { suffix: dto.suffix.trim() || null }
            : {}),
          ...(dto.gender !== undefined
            ? { gender: dto.gender.trim() || null }
            : {}),
          bio: dto.bio,
          avatar_url: dto.avatar_url,
          banner_url: dto.banner_url,
          title: dto.title,
          department: dto.department,
        },
      });
    }

    // Return updated user data
    const updatedUser = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!updatedUser) {
      throw new NotFoundException('Updated user record not found.');
    }

    await this.auditService.log(
      userId,
      'PROFILE_UPDATED',
      `User (ID: ${userId}) updated their profile`,
    );

    await this.cacheService?.del?.(jwtUserCacheKey(userId));

    const sanitizedUser: Partial<typeof updatedUser> = { ...updatedUser };
    delete sanitizedUser.password_hash;
    return sanitizedUser;
  }

  private async findLatestSettingsRecord(userId: number) {
    if (typeof this.prisma.auditLog?.findFirst !== 'function') {
      return null;
    }
    return this.prisma.auditLog.findFirst({
      where: {
        user_id: userId,
        action: USER_SETTINGS_AUDIT_ACTION,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  private async loadUserSettingsState(
    userId: number,
    userColumns?: UserSettingsColumnSource | null,
  ): Promise<{
    existingLogId?: number;
    current: StoredUserSettingsRecord;
  }> {
    const existing = await this.findLatestSettingsRecord(userId);
    const auditRecord = existing?.details
      ? parseStoredUserSettings(existing.details)
      : undefined;
    return {
      existingLogId: existing?.log_id,
      current: mergeUserColumnsIntoSettings(userColumns, auditRecord),
    };
  }

  private async persistStoredSettings(
    userId: number,
    record: StoredUserSettingsRecord,
    existingLogId?: number,
    timestamps?: {
      emailVerifiedAt?: Date | null;
      phoneVerifiedAt?: Date | null;
    },
  ): Promise<UserSettings> {
    if (typeof this.prisma.user?.update === 'function') {
      await this.prisma.user.update({
        where: { user_id: userId },
        data: {
          is_email_verified: record.emailVerified,
          ...(timestamps?.emailVerifiedAt !== undefined
            ? { email_verified_at: timestamps.emailVerifiedAt }
            : {}),
          two_factor_enabled: record.twoFactor,
          two_factor_method: record.twoFactor ? record.twoFactorMethod : null,
          two_factor_secret: record.twoFactorSecret ?? null,
          email_notifs: record.emailNotifs,
          sms_notifs: record.smsNotifs,
          forum_digest: record.forumDigest,
          public_profile: record.publicProfile,
          password_changed_at: record.passwordChangedAt
            ? new Date(record.passwordChangedAt)
            : null,
        },
      });
    }

    if (typeof this.prisma.scholarProfile?.updateMany === 'function') {
      await this.prisma.scholarProfile.updateMany({
        where: { user_id: userId },
        data: {
          is_phone_verified: record.phoneVerified,
          ...(timestamps?.phoneVerifiedAt !== undefined
            ? { phone_verified_at: timestamps.phoneVerifiedAt }
            : {}),
        },
      });
    }

    const serialized = JSON.stringify(record);
    if (existingLogId && typeof this.prisma.auditLog?.update === 'function') {
      await this.prisma.auditLog.update({
        where: { log_id: existingLogId },
        data: { details: serialized },
      });
    } else if (typeof this.prisma.auditLog?.create === 'function') {
      await this.prisma.auditLog.create({
        data: {
          user_id: userId,
          action: USER_SETTINGS_AUDIT_ACTION,
          details: serialized,
        },
      });
    }
    return stripInternalSettings(record);
  }

  private settingsUserSelect = {
    user_id: true,
    is_email_verified: true,
    email_verified_at: true,
    two_factor_enabled: true,
    two_factor_method: true,
    two_factor_secret: true,
    email_notifs: true,
    sms_notifs: true,
    forum_digest: true,
    public_profile: true,
    password_changed_at: true,
    scholar_profile: {
      select: {
        is_phone_verified: true,
        phone_verified_at: true,
      },
    },
  } as const;

  async getUserSettings(userId: number): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: this.settingsUserSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { current } = await this.loadUserSettingsState(userId, user);
    return stripInternalSettings(current);
  }

  async updateUserSettings(
    userId: number,
    dto: UpdateUserSettingsDto,
  ): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: this.settingsUserSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { existingLogId, current } = await this.loadUserSettingsState(
      userId,
      user,
    );

    if (dto.smsNotifs === true && !current.phoneVerified) {
      throw new BadRequestException(
        'Please verify your phone number before enabling SMS notifications.',
      );
    }

    const nextTwoFactor = dto.twoFactor ?? current.twoFactor;
    const updatedRecord: StoredUserSettingsRecord = {
      emailNotifs: dto.emailNotifs ?? current.emailNotifs,
      smsNotifs: dto.smsNotifs ?? current.smsNotifs,
      forumDigest: dto.forumDigest ?? current.forumDigest,
      twoFactor: nextTwoFactor,
      twoFactorMethod:
        nextTwoFactor === false
          ? null
          : (dto.twoFactorMethod ?? current.twoFactorMethod),
      emailVerified: current.emailVerified,
      phoneVerified: current.phoneVerified,
      publicProfile: dto.publicProfile ?? current.publicProfile,
      passwordChangedAt: current.passwordChangedAt,
      twoFactorSecret: nextTwoFactor === false ? null : current.twoFactorSecret,
      pendingTwoFactor:
        nextTwoFactor === false ? null : current.pendingTwoFactor,
      pendingContactVerification: current.pendingContactVerification,
    };

    const nextSettings = await this.persistStoredSettings(
      userId,
      updatedRecord,
      existingLogId,
    );

    const changedFields: string[] = [];
    if (
      dto.emailNotifs !== undefined &&
      dto.emailNotifs !== current.emailNotifs
    ) {
      changedFields.push(`emailNotifs=${dto.emailNotifs}`);
    }
    if (dto.smsNotifs !== undefined && dto.smsNotifs !== current.smsNotifs) {
      changedFields.push(`smsNotifs=${dto.smsNotifs}`);
    }
    if (
      dto.forumDigest !== undefined &&
      dto.forumDigest !== current.forumDigest
    ) {
      changedFields.push(`forumDigest=${dto.forumDigest}`);
    }
    if (
      dto.publicProfile !== undefined &&
      dto.publicProfile !== current.publicProfile
    ) {
      changedFields.push(`publicProfile=${dto.publicProfile}`);
    }

    if (changedFields.length > 0) {
      await this.auditService.log(
        userId,
        'USER_SETTINGS_UPDATED',
        `User (ID: ${userId}) updated settings: ${changedFields.join(', ')}`,
      );
    }

    if (dto.twoFactor === false && current.twoFactor) {
      await this.auditService.log(
        userId,
        'TWO_FACTOR_DISABLED',
        `User (ID: ${userId}) disabled two-factor authentication`,
      );
    }

    return nextSettings;
  }

  async initiateTwoFactorSetup(
    userId: number,
    dto: SetupTwoFactorDto,
  ): Promise<TwoFactorSetupResponse> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { existingLogId, current } = await this.loadUserSettingsState(
      userId,
      user,
    );
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    if (dto.method === 'AUTHENTICATOR_APP') {
      const secret = generateBase32Secret(20);
      const otpauthUrl = `otpauth://totp/ViaScholar:${encodeURIComponent(user.email)}?secret=${secret}&issuer=ViaScholar`;
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
        width: 200,
        margin: 1,
      });

      const pending: PendingTwoFactorSetup = {
        method: 'AUTHENTICATOR_APP',
        secret,
        expiresAt,
      };
      await this.persistStoredSettings(
        userId,
        { ...current, pendingTwoFactor: pending },
        existingLogId,
      );

      return {
        method: 'AUTHENTICATOR_APP',
        destination: user.email,
        expiresInMinutes: 10,
        qrCodeDataUrl,
        manualKey: secret,
      };
    }

    const code = String(randomInt(100000, 1000000));

    if (dto.method === 'SMS_OTP') {
      const phone = user.scholar_profile?.phone_number?.trim();
      if (!phone) {
        throw new BadRequestException(
          'Please add a mobile phone number in your profile before enabling SMS OTP.',
        );
      }

      const pending: PendingTwoFactorSetup = {
        method: 'SMS_OTP',
        code,
        expiresAt,
      };
      await this.persistStoredSettings(
        userId,
        { ...current, pendingTwoFactor: pending },
        existingLogId,
      );

      const firstName =
        user.scholar_profile?.first_name ||
        user.employee?.first_name ||
        'Scholar';
      const smsResult = await this.smsService?.sendOtpSms(phone, {
        subscriberId: `user_${userId}`,
        firstName,
        code,
        expiresInMinutes: 10,
        purpose: 'TWO_FACTOR_SETUP',
      });

      return {
        method: 'SMS_OTP',
        destination: phone,
        expiresInMinutes: 10,
        simulated: smsResult ? smsResult.simulated : true,
      };
    }

    const pending: PendingTwoFactorSetup = {
      method: 'EMAIL_OTP',
      code,
      expiresAt,
    };
    await this.persistStoredSettings(
      userId,
      { ...current, pendingTwoFactor: pending },
      existingLogId,
    );

    const userName =
      user.scholar_profile?.first_name ||
      user.employee?.first_name ||
      'Scholar';
    const mailResult = await this.mailService.sendTwoFactorOtpEmail(
      user.email,
      {
        userName,
        code,
        expiresInMinutes: 10,
      },
    );

    return {
      method: 'EMAIL_OTP',
      destination: user.email,
      expiresInMinutes: 10,
      simulated: mailResult.simulated,
    };
  }

  async verifyTwoFactorSetup(
    userId: number,
    dto: VerifyTwoFactorDto,
  ): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: this.settingsUserSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { existingLogId, current } = await this.loadUserSettingsState(
      userId,
      user,
    );
    const pending = current.pendingTwoFactor;

    if (
      !pending ||
      pending.method !== dto.method ||
      new Date(pending.expiresAt).getTime() <= Date.now()
    ) {
      throw new BadRequestException(
        'Verification session expired or not found. Please request a new code.',
      );
    }

    if (dto.method === 'AUTHENTICATOR_APP') {
      if (!pending.secret || !verifyTotpCode(pending.secret, dto.code)) {
        throw new BadRequestException(
          'Invalid authenticator verification code.',
        );
      }
    } else if (pending.code !== dto.code.trim()) {
      throw new BadRequestException('Invalid verification code.');
    }

    const emailNewlyVerified =
      dto.method === 'EMAIL_OTP' && !current.emailVerified;
    const phoneNewlyVerified =
      dto.method === 'SMS_OTP' && !current.phoneVerified;

    const nextRecord: StoredUserSettingsRecord = {
      ...current,
      twoFactor: true,
      twoFactorMethod: dto.method,
      emailVerified: dto.method === 'EMAIL_OTP' ? true : current.emailVerified,
      phoneVerified: dto.method === 'SMS_OTP' ? true : current.phoneVerified,
      twoFactorSecret:
        dto.method === 'AUTHENTICATOR_APP' ? (pending.secret ?? null) : null,
      pendingTwoFactor: null,
    };

    const nextSettings = await this.persistStoredSettings(
      userId,
      nextRecord,
      existingLogId,
      {
        ...(emailNewlyVerified ? { emailVerifiedAt: new Date() } : {}),
        ...(phoneNewlyVerified ? { phoneVerifiedAt: new Date() } : {}),
      },
    );

    await this.auditService.log(
      userId,
      'TWO_FACTOR_ENABLED',
      `User (ID: ${userId}) enabled two-factor authentication (${dto.method})`,
    );

    return nextSettings;
  }

  async initiateContactVerification(
    userId: number,
    dto: SendContactVerificationDto,
  ): Promise<ContactVerificationSetupResponse> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { existingLogId, current } = await this.loadUserSettingsState(
      userId,
      user,
    );
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const firstName =
      user.scholar_profile?.first_name ||
      user.employee?.first_name ||
      'Scholar';

    if (dto.channel === 'PHONE') {
      const phone = user.scholar_profile?.phone_number?.trim();
      if (!phone) {
        throw new BadRequestException(
          'Please add a mobile phone number in your profile before verifying your phone.',
        );
      }

      const pending: PendingContactVerification = {
        channel: 'PHONE',
        code,
        expiresAt,
      };
      await this.persistStoredSettings(
        userId,
        { ...current, pendingContactVerification: pending },
        existingLogId,
      );

      const smsResult = await this.smsService?.sendOtpSms(phone, {
        subscriberId: `user_${userId}`,
        firstName,
        code,
        expiresInMinutes: 10,
        purpose: 'PHONE_VERIFICATION',
      });

      return {
        channel: 'PHONE',
        destination: phone,
        expiresInMinutes: 10,
        simulated: smsResult ? smsResult.simulated : true,
      };
    }

    const pending: PendingContactVerification = {
      channel: 'EMAIL',
      code,
      expiresAt,
    };
    await this.persistStoredSettings(
      userId,
      { ...current, pendingContactVerification: pending },
      existingLogId,
    );

    const mailResult = await this.mailService.sendTwoFactorOtpEmail(
      user.email,
      {
        userName: firstName,
        code,
        expiresInMinutes: 10,
      },
    );

    return {
      channel: 'EMAIL',
      destination: user.email,
      expiresInMinutes: 10,
      simulated: mailResult.simulated,
    };
  }

  async verifyContactVerification(
    userId: number,
    dto: VerifyContactVerificationDto,
  ): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: this.settingsUserSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { existingLogId, current } = await this.loadUserSettingsState(
      userId,
      user,
    );
    const pending = current.pendingContactVerification;

    if (
      !pending ||
      pending.channel !== dto.channel ||
      new Date(pending.expiresAt).getTime() <= Date.now()
    ) {
      throw new BadRequestException(
        'Verification session expired or not found. Please request a new code.',
      );
    }

    if (pending.code !== dto.code.trim()) {
      throw new BadRequestException('Invalid verification code.');
    }

    const verifiedAt = new Date();
    const nextRecord: StoredUserSettingsRecord = {
      ...current,
      emailVerified: dto.channel === 'EMAIL' ? true : current.emailVerified,
      phoneVerified: dto.channel === 'PHONE' ? true : current.phoneVerified,
      pendingContactVerification: null,
    };

    const nextSettings = await this.persistStoredSettings(
      userId,
      nextRecord,
      existingLogId,
      dto.channel === 'EMAIL'
        ? { emailVerifiedAt: verifiedAt }
        : { phoneVerifiedAt: verifiedAt },
    );

    await this.auditService.log(
      userId,
      dto.channel === 'EMAIL' ? 'EMAIL_VERIFIED' : 'PHONE_VERIFIED',
      `User (ID: ${userId}) verified their ${dto.channel === 'EMAIL' ? 'email address' : 'phone number'}`,
    );

    return nextSettings;
  }

  async changePassword(userId: number, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const isCurrentValid = await bcrypt.compare(
      dto.current_password,
      user.password_hash,
    );
    if (!isCurrentValid) {
      throw new BadRequestException('Current password is incorrect.');
    }

    if (dto.current_password === dto.new_password) {
      throw new BadRequestException(
        'New password must be different from your current password.',
      );
    }

    const hashedPassword = await bcrypt.hash(dto.new_password, 10);
    await this.prisma.user.update({
      where: { user_id: userId },
      data: { password_hash: hashedPassword },
    });

    const passwordChangedAt = new Date().toISOString();
    const { existingLogId, current } = await this.loadUserSettingsState(
      userId,
      user,
    );

    await this.persistStoredSettings(
      userId,
      { ...current, passwordChangedAt },
      existingLogId,
    );

    await this.auditService.log(
      userId,
      'PASSWORD_CHANGED',
      `User (ID: ${userId}) changed their account password`,
    );

    return {
      message: 'Password updated successfully.',
      passwordChangedAt,
    };
  }

  async deactivateAccount(
    userId: number,
    dto: DeactivateAccountDto = {},
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    if (dto.password) {
      const isPasswordValid = await bcrypt.compare(
        dto.password,
        user.password_hash,
      );
      if (!isPasswordValid) {
        throw new BadRequestException('Incorrect password.');
      }
    }

    await this.prisma.user.update({
      where: { user_id: userId },
      data: { is_active: false },
    });

    const trimmedReason = dto.reason?.trim();
    const details = trimmedReason
      ? `User (ID: ${userId}) deactivated their account (Reason: ${trimmedReason})`
      : `User (ID: ${userId}) deactivated their account`;

    await this.auditService.log(userId, 'ACCOUNT_DEACTIVATED', details);
    await this.cacheService?.del?.(jwtUserCacheKey(userId));

    return {
      message: 'Your account has been deactivated.',
    };
  }

  async getPublicScholarProfile(
    requesterUserId: number,
    targetUserId: number,
  ): Promise<PublicScholarProfile> {
    const targetUser = await this.prisma.user.findUnique({
      where: { user_id: targetUserId },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
        public_profile: true,
        created_at: true,
        scholar_profile: {
          select: {
            first_name: true,
            middle_name: true,
            last_name: true,
            suffix: true,
            gender: true,
            bio: true,
            avatar_url: true,
            banner_url: true,
            school_name: true,
            course_of_study: true,
            current_year_level: true,
            scholarship_track: true,
          },
        },
      },
    });

    if (
      !targetUser ||
      !targetUser.is_active ||
      targetUser.role !== Role.SCHOLAR ||
      !targetUser.scholar_profile
    ) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const { current } = await this.loadUserSettingsState(targetUserId, {
      public_profile: targetUser.public_profile,
    });
    const isPublicProfile = current.publicProfile;
    const isSelf = requesterUserId === targetUserId;

    if (!isPublicProfile && !isSelf) {
      throw new ForbiddenException(
        'This scholar has chosen to keep their profile private.',
      );
    }

    const hasForumPostModel =
      typeof this.prisma.forumPost?.count === 'function' &&
      typeof this.prisma.forumPost?.findMany === 'function';
    const hasForumCommentModel =
      typeof this.prisma.forumComment?.count === 'function';

    const [forumPostsCount, forumCommentsCount, recentPosts] =
      await Promise.all([
        hasForumPostModel
          ? this.prisma.forumPost.count({
              where: { author_user_id: targetUserId },
            })
          : Promise.resolve(0),
        hasForumCommentModel
          ? this.prisma.forumComment.count({
              where: { author_user_id: targetUserId },
            })
          : Promise.resolve(0),
        hasForumPostModel
          ? this.prisma.forumPost.findMany({
              where: { author_user_id: targetUserId },
              orderBy: { created_at: 'desc' },
              take: 5,
              select: {
                post_id: true,
                title: true,
                category: true,
                views_count: true,
                created_at: true,
                _count: {
                  select: { comments: true },
                },
              },
            })
          : Promise.resolve(
              [] as Array<{
                post_id: number;
                title: string;
                category: string | null;
                views_count: number;
                created_at: Date;
                _count: { comments: number };
              }>,
            ),
      ]);

    const profile = targetUser.scholar_profile;

    return {
      user_id: targetUser.user_id,
      is_public: isPublicProfile,
      is_self: isSelf,
      first_name: profile.first_name,
      middle_name: profile.middle_name ?? null,
      last_name: profile.last_name,
      suffix: profile.suffix ?? null,
      gender: profile.gender ?? null,
      email: targetUser.email,
      bio: profile.bio ?? null,
      avatar_url: profile.avatar_url ?? null,
      banner_url: profile.banner_url ?? null,
      school_name: profile.school_name ?? null,
      course_of_study: profile.course_of_study ?? null,
      current_year_level: profile.current_year_level ?? null,
      scholarship_track: profile.scholarship_track ?? null,
      member_since: targetUser.created_at,
      forum_posts_count: forumPostsCount,
      forum_comments_count: forumCommentsCount,
      recent_posts: recentPosts.map((post) => ({
        post_id: post.post_id,
        title: post.title,
        category: post.category,
        views_count: post.views_count,
        comments_count: post._count?.comments ?? 0,
        created_at: post.created_at,
      })),
    };
  }
}
