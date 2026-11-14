import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { UpdateUserSettingsDto } from './dto/update-user-settings.dto.js';
import { SetupTwoFactorDto, VerifyTwoFactorDto } from './dto/two-factor.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import {
  type PendingTwoFactorSetup,
  type StoredUserSettingsRecord,
  type TwoFactorMethod,
  USER_SETTINGS_AUDIT_ACTION,
  type UserSettings,
  parseStoredUserSettings,
  parseUserSettings,
} from './user-settings.util.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(base32: string): Buffer {
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpCode(
  base32Secret: string,
  windowOffset = 0,
  timestampMs = Date.now(),
): string {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(timestampMs / 1000 / 30) + windowOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

function verifyTotpCode(base32Secret: string, inputCode: string): boolean {
  const normalized = inputCode.trim();
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }
  const now = Date.now();
  return [-1, 0, 1].some(
    (offset) => generateTotpCode(base32Secret, offset, now) === normalized,
  );
}

export interface TwoFactorSetupResponse {
  method: TwoFactorMethod;
  destination: string;
  expiresInMinutes: number;
  qrCodeDataUrl?: string;
  manualKey?: string;
  simulated?: boolean;
  simulationCode?: string;
}

@Injectable()
export class ProfileService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private auditService: AuditService,
    private mailService: MailService,
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
          last_name: dto.last_name,
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
    }
    // 2. If User is Staff (Coordinator / Grantor / Admin), update employees table
    else if (user.employee) {
      await this.prisma.employee.update({
        where: { employee_id: user.employee.employee_id },
        data: {
          first_name: dto.first_name,
          last_name: dto.last_name,
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

    const sanitizedUser: Partial<typeof updatedUser> = { ...updatedUser };
    delete sanitizedUser.password_hash;
    return sanitizedUser;
  }

  private async findLatestSettingsRecord(userId: number) {
    return this.prisma.auditLog.findFirst({
      where: {
        user_id: userId,
        action: USER_SETTINGS_AUDIT_ACTION,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  private async persistStoredSettings(
    userId: number,
    record: StoredUserSettingsRecord,
    existingLogId?: number,
  ): Promise<string> {
    const serialized = JSON.stringify(record);
    if (existingLogId) {
      await this.prisma.auditLog.update({
        where: { log_id: existingLogId },
        data: { details: serialized },
      });
    } else {
      await this.prisma.auditLog.create({
        data: {
          user_id: userId,
          action: USER_SETTINGS_AUDIT_ACTION,
          details: serialized,
        },
      });
    }
    return serialized;
  }

  async getUserSettings(userId: number): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { user_id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const record = await this.findLatestSettingsRecord(userId);
    return parseUserSettings(record?.details);
  }

  async updateUserSettings(
    userId: number,
    dto: UpdateUserSettingsDto,
  ): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { user_id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const existing = await this.findLatestSettingsRecord(userId);
    const current = parseStoredUserSettings(existing?.details);

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
      publicProfile: dto.publicProfile ?? current.publicProfile,
      passwordChangedAt: current.passwordChangedAt,
      twoFactorSecret: nextTwoFactor === false ? null : current.twoFactorSecret,
      pendingTwoFactor:
        nextTwoFactor === false ? null : current.pendingTwoFactor,
    };

    const serialized = await this.persistStoredSettings(
      userId,
      updatedRecord,
      existing?.log_id,
    );

    if (dto.twoFactor === false && current.twoFactor) {
      await this.auditService.log(
        userId,
        'TWO_FACTOR_DISABLED',
        `User (ID: ${userId}) disabled two-factor authentication`,
      );
    }

    return parseUserSettings(serialized);
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

    const existing = await this.findLatestSettingsRecord(userId);
    const current = parseStoredUserSettings(existing?.details);
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
        existing?.log_id,
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
        existing?.log_id,
      );

      return {
        method: 'SMS_OTP',
        destination: phone,
        expiresInMinutes: 10,
        simulated: true,
        simulationCode: code,
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
      existing?.log_id,
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

    const exposeSimulationCode =
      mailResult.simulated || process.env.NODE_ENV !== 'production';

    return {
      method: 'EMAIL_OTP',
      destination: user.email,
      expiresInMinutes: 10,
      simulated: mailResult.simulated,
      ...(exposeSimulationCode ? { simulationCode: code } : {}),
    };
  }

  async verifyTwoFactorSetup(
    userId: number,
    dto: VerifyTwoFactorDto,
  ): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { user_id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const existing = await this.findLatestSettingsRecord(userId);
    const current = parseStoredUserSettings(existing?.details);
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

    const nextRecord: StoredUserSettingsRecord = {
      ...current,
      twoFactor: true,
      twoFactorMethod: dto.method,
      twoFactorSecret:
        dto.method === 'AUTHENTICATOR_APP' ? (pending.secret ?? null) : null,
      pendingTwoFactor: null,
    };

    const serialized = await this.persistStoredSettings(
      userId,
      nextRecord,
      existing?.log_id,
    );

    await this.auditService.log(
      userId,
      'TWO_FACTOR_ENABLED',
      `User (ID: ${userId}) enabled two-factor authentication (${dto.method})`,
    );

    return parseUserSettings(serialized);
  }

  async changePassword(userId: number, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
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
    const existing = await this.findLatestSettingsRecord(userId);
    const current = parseStoredUserSettings(existing?.details);

    await this.persistStoredSettings(
      userId,
      { ...current, passwordChangedAt },
      existing?.log_id,
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
}
