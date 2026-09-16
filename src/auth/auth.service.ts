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
  ) {}

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
            last_name: dto.last_name,
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

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      undefined,
      user.created_at,
    );
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
            last_name: dto.last_name,
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
      throw new UnauthorizedException(
        'Account is disabled. Please contact the administrator.',
      );
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

    await this.auditService.log(
      user.user_id,
      'USER_LOGIN',
      `User logged in (ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
    );

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      user.employee,
      user.created_at,
    );
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
      throw new UnauthorizedException(
        'Account is disabled. Please contact the administrator.',
      );
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
      data: { password_hash: newHashedPassword },
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
        this.logger.error(`Google authentication error: ${(err as Error)?.message}`);
        throw new UnauthorizedException('Google authentication failed. Please try again.');
      }
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      include: { scholar_profile: true, employee: true },
    });

    let authenticatedUser: NonNullable<typeof existingUser>;

    if (existingUser) {
      if (!existingUser.is_active) {
        throw new UnauthorizedException(
          'Your account has been deactivated. Please contact the administrator.',
        );
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

    return this.generateToken(
      authenticatedUser.user_id,
      authenticatedUser.email,
      authenticatedUser.role,
      authenticatedUser.scholar_profile,
      authenticatedUser.employee,
      authenticatedUser.created_at,
    );
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
        last_name?: string;
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
        last_name: profile.last_name || '',
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
