import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { google } from 'googleapis';
import { RegisterScholarDto } from './dto/register-scholar.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { GoogleLoginDto } from './dto/google-login.dto.js';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { MailService } from '../mail/mail.service.js';

import { Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { SmsService } from '../sms/sms.service.js';
import {
  USER_SETTINGS_AUDIT_ACTION,
  type StoredUserSettingsRecord,
  type TwoFactorMethod,
  type UserSettingsColumnSource,
  mergeUserColumnsIntoSettings,
  parseStoredUserSettings,
} from './user-settings.util.js';
import {
  signMfaChallengeToken,
  signTrustedDeviceToken,
  verifyMfaChallengeToken,
  verifyTotpCode,
  verifyTrustedDeviceToken,
} from './mfa-token.util.js';
import type {
  SendMfaChallengeDto,
  VerifyMfaChallengeDto,
} from './dto/mfa-challenge.dto.js';

function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return phone;
  return `${phone.slice(0, Math.min(4, phone.length - 4))}***${digits.slice(-4)}`;
}

interface MfaUserSummary {
  user_id: number;
  email: string;
  scholar_profile?: {
    first_name?: string | null;
    phone_number?: string | null;
  } | null;
  employee?: {
    first_name?: string | null;
  } | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private auditService: AuditService,
    private eventsGateway: EventsGateway,
    private mailService: MailService,
    private configService: ConfigService,
    @Optional() private smsService?: SmsService,
  ) {}

  private async getStoredUserSettings(
    userId: number,
    userColumns?: UserSettingsColumnSource | null,
  ): Promise<{
    logId?: number;
    settings: StoredUserSettingsRecord;
  }> {
    const existing = await this.prisma.auditLog?.findFirst?.({
      where: {
        user_id: userId,
        action: USER_SETTINGS_AUDIT_ACTION,
      },
      orderBy: { created_at: 'desc' },
    });

    const auditRecord = existing?.details
      ? parseStoredUserSettings(existing.details)
      : undefined;

    return {
      logId: existing?.log_id,
      settings: mergeUserColumnsIntoSettings(userColumns, auditRecord),
    };
  }

  private async persistStoredUserSettings(
    userId: number,
    next: StoredUserSettingsRecord,
    logId?: number,
    timestamps?: {
      emailVerifiedAt?: Date | null;
      phoneVerifiedAt?: Date | null;
    },
  ): Promise<void> {
    if (typeof this.prisma.user?.update === 'function') {
      await this.prisma.user.update({
        where: { user_id: userId },
        data: {
          is_email_verified: next.emailVerified,
          ...(timestamps?.emailVerifiedAt !== undefined
            ? { email_verified_at: timestamps.emailVerifiedAt }
            : {}),
          two_factor_enabled: next.twoFactor,
          two_factor_method: next.twoFactor ? next.twoFactorMethod : null,
          two_factor_secret: next.twoFactorSecret ?? null,
          email_notifs: next.emailNotifs,
          sms_notifs: next.smsNotifs,
          forum_digest: next.forumDigest,
          public_profile: next.publicProfile,
          password_changed_at: next.passwordChangedAt
            ? new Date(next.passwordChangedAt)
            : null,
        },
      });
    }

    if (typeof this.prisma.scholarProfile?.updateMany === 'function') {
      await this.prisma.scholarProfile.updateMany({
        where: { user_id: userId },
        data: {
          is_phone_verified: next.phoneVerified,
          ...(timestamps?.phoneVerifiedAt !== undefined
            ? { phone_verified_at: timestamps.phoneVerifiedAt }
            : {}),
        },
      });
    }

    if (!this.prisma.auditLog) return;

    const serialized = JSON.stringify(next);
    if (logId && this.prisma.auditLog.update) {
      await this.prisma.auditLog.update({
        where: { log_id: logId },
        data: { details: serialized },
      });
      return;
    }

    if (this.prisma.auditLog.create) {
      await this.prisma.auditLog.create({
        data: {
          user_id: userId,
          action: USER_SETTINGS_AUDIT_ACTION,
          details: serialized,
        },
      });
    }
  }

  private async dispatchMfaOtp(params: {
    user: MfaUserSummary;
    method: 'EMAIL_OTP' | 'SMS_OTP';
    settings: StoredUserSettingsRecord;
    logId?: number;
  }): Promise<{ destination: string }> {
    const { user, method, settings, logId } = params;
    const phone = user.scholar_profile?.phone_number?.trim() || '';
    if (method === 'SMS_OTP' && !phone) {
      throw new BadRequestException(
        'No mobile phone number is registered on this account.',
      );
    }

    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await this.persistStoredUserSettings(
      user.user_id,
      {
        ...settings,
        pendingTwoFactor: {
          method,
          code,
          expiresAt,
        },
      },
      logId,
    );

    const firstName =
      user.scholar_profile?.first_name ||
      user.employee?.first_name ||
      'Scholar';

    if (method === 'SMS_OTP') {
      await this.smsService?.sendOtpSms(phone, {
        subscriberId: `user_${user.user_id}`,
        firstName,
        code,
        expiresInMinutes: 10,
        purpose: 'AUTH_MFA',
      });

      return {
        destination: maskPhoneNumber(phone),
      };
    }

    await this.mailService.sendTwoFactorOtpEmail?.(user.email, {
      userName: firstName,
      code,
      expiresInMinutes: 10,
    });

    return {
      destination: user.email,
    };
  }

  private resolveLoginMfaMethod(
    settings: StoredUserSettingsRecord,
    phone: string | null,
  ): TwoFactorMethod {
    const preferred: TwoFactorMethod = settings.twoFactorMethod ?? 'EMAIL_OTP';
    if (preferred === 'SMS_OTP' && !phone) {
      return 'EMAIL_OTP';
    }
    if (preferred === 'AUTHENTICATOR_APP' && !settings.twoFactorSecret) {
      return 'EMAIL_OTP';
    }
    return preferred;
  }

  private async createMfaChallengeForUser(params: {
    user: MfaUserSummary;
    purpose: 'REGISTER' | 'LOGIN';
    rememberSession?: boolean;
    settings: StoredUserSettingsRecord;
    logId?: number;
  }) {
    const { user, purpose, rememberSession, settings, logId } = params;
    const phone = user.scholar_profile?.phone_number?.trim() || null;

    const activeMethod: TwoFactorMethod =
      purpose === 'REGISTER'
        ? 'EMAIL_OTP'
        : this.resolveLoginMfaMethod(settings, phone);

    const availableMethods: TwoFactorMethod[] =
      purpose === 'REGISTER'
        ? phone
          ? ['EMAIL_OTP', 'SMS_OTP']
          : ['EMAIL_OTP']
        : [activeMethod];

    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const mfaToken = signMfaChallengeToken(
      {
        userId: user.user_id,
        email: user.email,
        purpose,
        rememberSession: Boolean(rememberSession),
      },
      jwtSecret,
    );

    if (activeMethod === 'AUTHENTICATOR_APP') {
      return {
        mfa_required: true,
        mfa_purpose: purpose,
        account_verification_required: purpose === 'REGISTER',
        mfa_token: mfaToken,
        mfa_method: activeMethod,
        mfa_destination: user.email,
        email_destination: user.email,
        phone_destination: phone ? maskPhoneNumber(phone) : null,
        available_methods: availableMethods,
      };
    }

    const dispatched = await this.dispatchMfaOtp({
      user,
      method: activeMethod,
      settings,
      logId,
    });

    return {
      mfa_required: true,
      mfa_purpose: purpose,
      account_verification_required: purpose === 'REGISTER',
      mfa_token: mfaToken,
      mfa_method: activeMethod,
      mfa_destination: dispatched.destination,
      email_destination: user.email,
      phone_destination: phone ? maskPhoneNumber(phone) : null,
      available_methods: availableMethods,
    };
  }

  async sendMfaChallenge(dto: SendMfaChallengeDto) {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const payload = verifyMfaChallengeToken(dto.mfa_token, jwtSecret);
    if (!payload) {
      throw new UnauthorizedException(
        'Your verification session has expired. Please try again.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: payload.userId },
      include: { scholar_profile: true, employee: true },
    });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('User account is unavailable.');
    }

    const { logId, settings } = await this.getStoredUserSettings(
      user.user_id,
      user,
    );
    if (payload.purpose === 'LOGIN') {
      const phone = user.scholar_profile?.phone_number?.trim() || null;
      const configuredMethod = this.resolveLoginMfaMethod(settings, phone);
      if (dto.method !== configuredMethod) {
        throw new BadRequestException(
          'Channel switching is only available during registration.',
        );
      }
    }

    const dispatched = await this.dispatchMfaOtp({
      user,
      method: dto.method,
      settings,
      logId,
    });

    return {
      mfa_method: dto.method,
      mfa_destination: dispatched.destination,
    };
  }

  async verifyMfaChallenge(dto: VerifyMfaChallengeDto) {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const payload = verifyMfaChallengeToken(dto.mfa_token, jwtSecret);
    if (!payload) {
      throw new UnauthorizedException(
        'Your verification session has expired. Please sign in again.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: payload.userId },
      include: { scholar_profile: true, employee: true },
    });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('User account is unavailable.');
    }

    const { logId, settings } = await this.getStoredUserSettings(
      user.user_id,
      user,
    );
    const method: TwoFactorMethod =
      dto.method ??
      (settings.twoFactorMethod === 'AUTHENTICATOR_APP' &&
      !settings.pendingTwoFactor
        ? 'AUTHENTICATOR_APP'
        : (settings.pendingTwoFactor?.method ??
          settings.twoFactorMethod ??
          'EMAIL_OTP'));

    if (method === 'AUTHENTICATOR_APP') {
      if (
        !settings.twoFactorSecret ||
        !verifyTotpCode(settings.twoFactorSecret, dto.code)
      ) {
        throw new BadRequestException('Invalid verification code.');
      }
    } else {
      const pending = settings.pendingTwoFactor;
      if (!pending || pending.method !== method) {
        throw new BadRequestException(
          'No active verification code found. Please request a new code.',
        );
      }
      if (new Date(pending.expiresAt).getTime() <= Date.now()) {
        throw new BadRequestException(
          'Verification code has expired. Please request a new code.',
        );
      }
      if (pending.code !== dto.code.trim()) {
        throw new BadRequestException('Invalid verification code.');
      }
    }

    const emailNewlyVerified =
      method === 'EMAIL_OTP' && !settings.emailVerified;
    const phoneNewlyVerified = method === 'SMS_OTP' && !settings.phoneVerified;

    await this.persistStoredUserSettings(
      user.user_id,
      {
        ...settings,
        emailVerified: method === 'EMAIL_OTP' ? true : settings.emailVerified,
        phoneVerified: method === 'SMS_OTP' ? true : settings.phoneVerified,
        pendingTwoFactor: null,
      },
      logId,
      {
        ...(emailNewlyVerified ? { emailVerifiedAt: new Date() } : {}),
        ...(phoneNewlyVerified ? { phoneVerifiedAt: new Date() } : {}),
      },
    );

    if (payload.purpose === 'REGISTER') {
      await this.auditService.log(
        user.user_id,
        'SCHOLAR_MFA_VERIFIED',
        `Scholar verified registration MFA (${method}) (User ID: ${user.user_id}, Email: ${user.email})`,
      );
    } else {
      await this.auditService.log(
        user.user_id,
        'USER_LOGIN',
        `User logged in via MFA (${method}) (ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
      );
    }

    const tokenPayload = await this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      user.employee,
      user.created_at,
    );

    const trustedDeviceToken = dto.remember_device
      ? signTrustedDeviceToken(user.user_id, jwtSecret)
      : undefined;

    return {
      ...tokenPayload,
      ...(trustedDeviceToken
        ? { trusted_device_token: trustedDeviceToken }
        : {}),
    };
  }

  // 1. Public Scholar Signup
  async registerScholar(dto: RegisterScholarDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email address is already in use.');
    }

    const existingPhone = await this.prisma.scholarProfile.findFirst({
      where: { phone_number: dto.phone_number },
    });

    if (existingPhone) {
      throw new ConflictException('Phone number is already registered.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        role: Role.APPLICANT,
        scholar_profile: {
          create: {
            first_name: dto.first_name,
            ...(dto.middle_name?.trim()
              ? { middle_name: dto.middle_name.trim() }
              : {}),
            last_name: dto.last_name,
            ...(dto.suffix?.trim() ? { suffix: dto.suffix.trim() } : {}),
            ...(dto.gender?.trim() ? { gender: dto.gender.trim() } : {}),
            phone_number: dto.phone_number,
          },
        },
      },
      include: { scholar_profile: true },
    });

    if (!user.scholar_profile) {
      throw new InternalServerErrorException(
        'Scholar profile was not created successfully.',
      );
    }

    await this.auditService.log(
      user.user_id,
      'SCHOLAR_REGISTERED',
      `Scholar registered (User ID: ${user.user_id}, Email: ${user.email})`,
    );

    const { logId, settings } = await this.getStoredUserSettings(
      user.user_id,
      user,
    );
    const tokenPayload = await this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      undefined,
      user.created_at,
    );
    const mfaChallenge = await this.createMfaChallengeForUser({
      user,
      purpose: 'REGISTER',
      rememberSession: false,
      settings,
      logId,
    });

    return {
      ...tokenPayload,
      ...mfaChallenge,
    };
  }

  // 2. Admin/Grantor creates Staff Accounts
  async createStaff(dto: CreateStaffDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email address is already in use.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        role: dto.role,
        employee: {
          create: {
            first_name: dto.first_name,
            ...(dto.middle_name?.trim()
              ? { middle_name: dto.middle_name.trim() }
              : {}),
            last_name: dto.last_name,
            ...(dto.suffix?.trim() ? { suffix: dto.suffix.trim() } : {}),
            ...(dto.gender?.trim() ? { gender: dto.gender.trim() } : {}),
            title: dto.title,
            department: dto.department,
          },
        },
      },
      include: { employee: true },
    });

    if (!user.employee) {
      throw new InternalServerErrorException(
        'Staff profile was not created successfully.',
      );
    }

    await this.auditService.log(
      user.user_id,
      'STAFF_CREATED',
      `Staff account created (User ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
    );

    this.eventsGateway.emitToAdmin('staff:created', {
      id: user.user_id,
      user_id: user.user_id,
      email: user.email,
      role: user.role,
      employee: user.employee,
    });

    return {
      message: 'Staff account successfully created.',
      user: {
        id: user.user_id,
        email: user.email,
        role: user.role,
        employee: user.employee,
      },
    };
  }

  // 3. Global Login (Scholar and Staff)
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (!user.is_active) {
      // Allow archived applicants & scholars to log in for read-only status/records view
      if (
        (user.role === Role.APPLICANT || user.role === Role.SCHOLAR) &&
        user.scholar_profile?.archived_at
      ) {
        await this.prisma.user.update({
          where: { user_id: user.user_id },
          data: { is_active: true },
        });
        user.is_active = true;
      } else {
        throw new UnauthorizedException(
          'Account is disabled. Please contact the administrator.',
        );
      }
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.password_hash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    // Update last login timestamp
    await this.prisma.user.update({
      where: { user_id: user.user_id },
      data: { last_login_at: new Date() },
    });

    const { logId, settings } = await this.getStoredUserSettings(
      user.user_id,
      user,
    );
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const isTrustedDevice = verifyTrustedDeviceToken(
      dto.trusted_device_token,
      user.user_id,
      jwtSecret,
    );

    const tokenPayload = await this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      user.employee,
      user.created_at,
    );

    const needsAccountVerification =
      user.is_email_verified === false &&
      user.scholar_profile?.is_phone_verified !== true &&
      !settings.emailVerified &&
      !settings.phoneVerified &&
      (user.role === Role.APPLICANT || user.role === Role.SCHOLAR);

    if (needsAccountVerification || (settings.twoFactor && !isTrustedDevice)) {
      const challengePurpose: 'REGISTER' | 'LOGIN' = needsAccountVerification
        ? 'REGISTER'
        : 'LOGIN';

      await this.auditService.log(
        user.user_id,
        'USER_LOGIN_MFA_REQUIRED',
        needsAccountVerification
          ? `Account verification OTP required on login (ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`
          : `MFA verification required for login (ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
      );

      const mfaChallenge = await this.createMfaChallengeForUser({
        user,
        purpose: challengePurpose,
        rememberSession: false,
        settings,
        logId,
      });

      return {
        ...tokenPayload,
        ...mfaChallenge,
      };
    }

    await this.auditService.log(
      user.user_id,
      'USER_LOGIN',
      `User logged in (ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
    );

    return tokenPayload;
  }

  // 4. Refresh / Re-issue token with fresh role and profile
  async refreshToken(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found.');
    }

    if (!user.is_active) {
      // Allow archived applicants & scholars to log in for read-only status/records view
      if (
        (user.role === Role.APPLICANT || user.role === Role.SCHOLAR) &&
        user.scholar_profile?.archived_at
      ) {
        await this.prisma.user.update({
          where: { user_id: user.user_id },
          data: { is_active: true },
        });
        user.is_active = true;
      } else {
        throw new UnauthorizedException(
          'Account is disabled. Please contact the administrator.',
        );
      }
    }

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      user.employee,
      user.created_at,
    );
  }

  // 5. Request Password Reset Link via Email
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
      include: { scholar_profile: true, employee: true },
    });

    // For privacy, return success message even if account is not found
    if (!user || !user.is_active) {
      return {
        message:
          'If an account exists with this email address, a password reset link has been sent.',
      };
    }

    // Generate signed token with 30-min expiry, keyed to the current password hash snippet
    const hashSnippet = (user.password_hash || '').substring(0, 10);
    const token = await this.jwtService.signAsync(
      {
        sub: user.user_id,
        email: user.email,
        type: 'PASSWORD_RESET',
        h: hashSnippet,
      },
      { expiresIn: '30m' },
    );

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

    const profileName =
      user.scholar_profile?.first_name ||
      user.employee?.first_name ||
      'Scholar';

    await this.mailService.sendPasswordResetEmail(user.email, {
      userName: profileName,
      resetUrl,
      expiresInMinutes: 30,
    });

    await this.auditService.log(
      user.user_id,
      'PASSWORD_RESET_REQUESTED',
      `Password reset email sent to ${user.email}`,
    );

    return {
      message:
        'If an account exists with this email address, a password reset link has been sent.',
    };
  }

  // 6. Execute Password Reset with Token
  async resetPassword(dto: ResetPasswordDto) {
    let payload: { sub: number; email: string; type: string; h: string };
    try {
      payload = await this.jwtService.verifyAsync(dto.token);
    } catch {
      throw new BadRequestException(
        'The password reset link is invalid or has expired. Please request a new one.',
      );
    }

    if (payload.type !== 'PASSWORD_RESET' || !payload.sub) {
      throw new BadRequestException('Invalid password reset token.');
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: payload.sub },
    });

    if (!user) {
      throw new BadRequestException('User not found.');
    }

    // Verify the password hash snippet matches to ensure single-use
    const currentHashSnippet = (user.password_hash || '').substring(0, 10);
    if (payload.h !== currentHashSnippet) {
      throw new BadRequestException(
        'This password reset link has already been used. Please request a new one.',
      );
    }

    const newHashedPassword = await bcrypt.hash(dto.new_password, 10);

    await this.prisma.user.update({
      where: { user_id: user.user_id },
      data: {
        password_hash: newHashedPassword,
        password_changed_at: new Date(),
      },
    });

    await this.auditService.log(
      user.user_id,
      'PASSWORD_RESET_COMPLETED',
      `User ${user.email} successfully reset their password`,
    );

    return {
      message: 'Your password has been successfully reset. You can now log in.',
    };
  }

  // 7. Google OAuth Sign-in & Registration
  async googleLogin(dto: GoogleLoginDto) {
    let email = '';
    let firstName = '';
    let lastName = '';
    let picture = '';

    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const isDirectEmail =
      dto.credential.includes('@') && dto.credential.split('.').length !== 3;

    if (isDirectEmail) {
      // Allow direct email parsing for dev testing / quick test sign-ins
      email = dto.credential.toLowerCase().trim();
      firstName = email.split('@')[0];
      lastName = '';
      picture = '';
    } else {
      try {
        if (clientId) {
          const oauth2Client = new google.auth.OAuth2(clientId);
          const ticket = await oauth2Client.verifyIdToken({
            idToken: dto.credential,
            audience: clientId,
          });
          const payload = ticket.getPayload();
          if (!payload || !payload.email) {
            throw new UnauthorizedException('Invalid Google token payload.');
          }
          email = payload.email.toLowerCase().trim();
          firstName = payload.given_name || payload.name || 'Scholar';
          lastName = payload.family_name || '';
          picture = payload.picture || '';
        } else {
          // Fallback: Verify directly with Google TokenInfo endpoint
          const res = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(dto.credential)}`,
          );
          if (!res.ok) {
            throw new UnauthorizedException('Failed to verify Google token.');
          }
          const data = (await res.json()) as {
            email?: string;
            given_name?: string;
            family_name?: string;
            name?: string;
            picture?: string;
            email_verified?: string | boolean;
          };

          if (!data.email) {
            throw new UnauthorizedException('Google account email not found.');
          }
          email = data.email.toLowerCase().trim();
          firstName = data.given_name || data.name || 'Scholar';
          lastName = data.family_name || '';
          picture = data.picture || '';
        }
      } catch (err) {
        this.logger.error(
          `Google authentication error: ${(err as Error)?.message}`,
        );
        throw new UnauthorizedException(
          'Google authentication failed. Please try again.',
        );
      }
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      include: { scholar_profile: true, employee: true },
    });

    let authenticatedUser: NonNullable<typeof existingUser>;

    if (existingUser) {
      if (!existingUser.is_active) {
        if (
          existingUser.role === Role.APPLICANT &&
          existingUser.scholar_profile?.archived_at
        ) {
          await this.prisma.user.update({
            where: { user_id: existingUser.user_id },
            data: { is_active: true },
          });
          existingUser.is_active = true;
        } else {
          throw new UnauthorizedException(
            'Your account has been deactivated. Please contact the administrator.',
          );
        }
      }

      authenticatedUser = await this.prisma.user.update({
        where: { user_id: existingUser.user_id },
        data: { last_login_at: new Date() },
        include: { scholar_profile: true, employee: true },
      });

      await this.auditService.log(
        authenticatedUser.user_id,
        'GOOGLE_LOGIN',
        `User ${authenticatedUser.email} logged in via Google OAuth`,
      );
    } else {
      // Auto-register as APPLICANT with verified email
      const randomPassword = await bcrypt.hash(
        `GoogleOAuth_${Date.now()}_${Math.random()}`,
        10,
      );

      authenticatedUser = await this.prisma.user.create({
        data: {
          email,
          password_hash: randomPassword,
          role: Role.APPLICANT,
          is_active: true,
          scholar_profile: {
            create: {
              first_name: firstName,
              last_name: lastName,
              phone_number: '',
              avatar_url: picture || undefined,
            },
          },
        },
        include: { scholar_profile: true, employee: true },
      });

      await this.auditService.log(
        authenticatedUser.user_id,
        'GOOGLE_REGISTER',
        `New applicant registered via Google OAuth (${authenticatedUser.email})`,
      );

      this.eventsGateway.emitToAdmin('user:created', {
        userId: authenticatedUser.user_id,
        email: authenticatedUser.email,
        role: authenticatedUser.role,
      });
    }

    const { logId, settings: loadedSettings } =
      await this.getStoredUserSettings(
        authenticatedUser.user_id,
        authenticatedUser,
      );
    let settings = loadedSettings;
    if (!settings.emailVerified) {
      settings = {
        ...settings,
        emailVerified: true,
      };
      await this.persistStoredUserSettings(
        authenticatedUser.user_id,
        settings,
        logId,
        { emailVerifiedAt: new Date() },
      );
    }
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const isTrustedDevice = verifyTrustedDeviceToken(
      dto.trusted_device_token,
      authenticatedUser.user_id,
      jwtSecret,
    );

    const tokenPayload = await this.generateToken(
      authenticatedUser.user_id,
      authenticatedUser.email,
      authenticatedUser.role,
      authenticatedUser.scholar_profile,
      authenticatedUser.employee,
      authenticatedUser.created_at,
    );

    const requiresAdditionalMfa =
      settings.twoFactor &&
      (settings.twoFactorMethod === 'SMS_OTP' ||
        settings.twoFactorMethod === 'AUTHENTICATOR_APP') &&
      !isTrustedDevice;

    if (requiresAdditionalMfa) {
      const mfaChallenge = await this.createMfaChallengeForUser({
        user: authenticatedUser,
        purpose: 'LOGIN',
        rememberSession: false,
        settings,
        logId,
      });

      return {
        ...tokenPayload,
        ...mfaChallenge,
      };
    }

    return tokenPayload;
  }

  private async generateToken(
    userId: number,
    email: string,
    role: string,
    scholar_profile?: unknown,
    employee?: unknown,
    created_at?: Date,
  ) {
    const payload = { sub: userId, email, role };
    const token = await this.jwtService.signAsync(payload);
    const profile =
      ((scholar_profile ?? employee ?? {}) as {
        first_name?: string;
        middle_name?: string | null;
        last_name?: string;
        suffix?: string | null;
        gender?: string | null;
        bio?: string;
        avatar_url?: string;
        banner_url?: string;
      }) || {};

    return {
      access_token: token,
      user: {
        id: userId,
        user_id: userId,
        email,
        role,
        first_name: profile.first_name || '',
        middle_name: profile.middle_name ?? null,
        last_name: profile.last_name || '',
        suffix: profile.suffix ?? null,
        gender: profile.gender ?? null,
        bio: profile.bio ?? null,
        avatar_url: profile.avatar_url ?? null,
        banner_url: profile.banner_url ?? null,
        created_at: created_at ?? null,
        scholar_profile: scholar_profile ?? null,
        employee: employee ?? null,
      },
    };
  }
}
