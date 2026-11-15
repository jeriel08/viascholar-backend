import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { google } from 'googleapis';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { SmsService } from '../sms/sms.service.js';
import { generateTotpCode, signTrustedDeviceToken } from './mfa-token.util.js';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { MailService } from '../mail/mail.service.js';
import { Role } from '../generated/prisma/enums.js';

const createPrismaMock = () => ({
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  scholarProfile: {
    findFirst: vi.fn(),
  },
});

const createJwtMock = () => ({
  signAsync: vi.fn(),
  verifyAsync: vi.fn(),
});

const createAuditMock = () => ({
  log: vi.fn(),
});

const createEventsMock = () => ({
  emitToAdmin: vi.fn(),
});

const createMailMock = () => ({
  sendPasswordResetEmail: vi.fn(),
});

const createConfigMock = () => ({
  get: vi.fn(),
});

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 1,
  email: 'scholar@example.com',
  password_hash: 'abcdefghijklmnop',
  role: Role.SCHOLAR,
  is_active: true,
  created_at: new Date('2025-01-01T00:00:00.000Z'),
  scholar_profile: {
    profile_id: 10,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    bio: 'Scholar bio',
    avatar_url: 'https://cdn.test/avatar.png',
    banner_url: null,
  },
  employee: null,
  ...overrides,
});

const makeEmployeeUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 2,
  email: 'coordinator@example.com',
  password_hash: 'hashed-password',
  role: Role.COORDINATOR,
  is_active: true,
  created_at: new Date('2025-01-01T00:00:00.000Z'),
  scholar_profile: null,
  employee: {
    employee_id: 20,
    first_name: 'Maria',
    last_name: 'Santos',
    bio: null,
    avatar_url: null,
    banner_url: null,
  },
  ...overrides,
});

const makeRegisterDto = (overrides: Record<string, unknown> = {}) => ({
  email: 'new.scholar@example.com',
  password: 'Password123!',
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  phone_number: '09171234567',
  ...overrides,
});

const makeLoginDto = (overrides: Record<string, unknown> = {}) => ({
  email: 'scholar@example.com',
  password: 'Password123!',
  ...overrides,
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let jwt: ReturnType<typeof createJwtMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;
  let mail: ReturnType<typeof createMailMock>;
  let config: ReturnType<typeof createConfigMock>;

  beforeEach(async () => {
    // Google failure paths are tested on purpose; keep the expected error
    // output out of the terminal while still asserting the thrown exception.
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    jwt = createJwtMock();
    audit = createAuditMock();
    events = createEventsMock();
    mail = createMailMock();
    config = createConfigMock();

    jwt.signAsync.mockResolvedValue('signed-access-token');
    config.get.mockImplementation((key: string) =>
      key === 'FRONTEND_URL' ? 'https://viascholar.test' : undefined,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: MailService, useValue: mail },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('registerScholar', () => {
    it('rejects an email that is already registered', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.registerScholar(makeRegisterDto())).rejects.toThrow(
        new ConflictException('Email address is already in use.'),
      );

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects a phone number that is already registered', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.scholarProfile.findFirst.mockResolvedValue({ profile_id: 99 });

      await expect(service.registerScholar(makeRegisterDto())).rejects.toThrow(
        new ConflictException('Phone number is already registered.'),
      );

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates an applicant account with a hashed password and returns a token', async () => {
      const dto = makeRegisterDto();
      const createdUser = makeUser({
        user_id: 7,
        email: dto.email,
        role: Role.APPLICANT,
        password_hash: 'unused-in-response',
        scholar_profile: {
          profile_id: 70,
          first_name: dto.first_name,
          last_name: dto.last_name,
          bio: null,
          avatar_url: null,
          banner_url: null,
        },
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.scholarProfile.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(createdUser);

      const result = await service.registerScholar(dto);

      const createArgs = prisma.user.create.mock.calls[0]?.[0] as unknown as {
        data: {
          email: string;
          password_hash: string;
          role: string;
          scholar_profile: {
            create: {
              first_name: string;
              last_name: string;
              phone_number: string;
            };
          };
        };
      };

      expect(createArgs.data.email).toBe(dto.email);
      expect(createArgs.data.role).toBe(Role.APPLICANT);
      expect(createArgs.data.password_hash).not.toBe(dto.password);
      await expect(
        bcrypt.compare(dto.password, createArgs.data.password_hash),
      ).resolves.toBe(true);
      expect(createArgs.data.scholar_profile.create).toEqual({
        first_name: dto.first_name,
        last_name: dto.last_name,
        phone_number: dto.phone_number,
      });

      expect(audit.log).toHaveBeenCalledWith(
        createdUser.user_id,
        'SCHOLAR_REGISTERED',
        expect.stringContaining(createdUser.email),
      );
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: createdUser.user_id,
        email: createdUser.email,
        role: createdUser.role,
      });

      expect(result.access_token).toBe('signed-access-token');
      expect(result.user).toMatchObject({
        id: createdUser.user_id,
        user_id: createdUser.user_id,
        email: createdUser.email,
        role: Role.APPLICANT,
        first_name: dto.first_name,
        last_name: dto.last_name,
      });
    });

    it('throws when the scholar profile was not created', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.scholarProfile.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser({ scholar_profile: null }));

      await expect(service.registerScholar(makeRegisterDto())).rejects.toThrow(
        new InternalServerErrorException(
          'Scholar profile was not created successfully.',
        ),
      );
    });
  });

  describe('createStaff', () => {
    const staffDto = {
      email: 'new.coordinator@example.com',
      password: 'Password123!',
      role: Role.COORDINATOR,
      first_name: 'Maria',
      last_name: 'Santos',
      title: 'Coordinator',
      department: 'Scholarships',
    };

    it('rejects an email that is already registered', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.createStaff(staffDto)).rejects.toThrow(
        new ConflictException('Email address is already in use.'),
      );

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates a staff account, writes an audit entry, and notifies admins', async () => {
      const createdUser = makeEmployeeUser({
        user_id: 21,
        email: staffDto.email,
        role: staffDto.role,
        employee: {
          employee_id: 22,
          first_name: staffDto.first_name,
          last_name: staffDto.last_name,
          title: staffDto.title,
          department: staffDto.department,
        },
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(createdUser);

      const result = await service.createStaff(staffDto);

      const createArgs = prisma.user.create.mock.calls[0]?.[0] as unknown as {
        data: {
          email: string;
          password_hash: string;
          role: string;
          employee: {
            create: {
              first_name: string;
              last_name: string;
              title: string;
              department: string;
            };
          };
        };
      };

      expect(createArgs.data.email).toBe(staffDto.email);
      expect(createArgs.data.role).toBe(staffDto.role);
      expect(createArgs.data.password_hash).not.toBe(staffDto.password);
      expect(createArgs.data.employee.create).toEqual({
        first_name: staffDto.first_name,
        last_name: staffDto.last_name,
        title: staffDto.title,
        department: staffDto.department,
      });

      expect(audit.log).toHaveBeenCalledWith(
        createdUser.user_id,
        'STAFF_CREATED',
        expect.stringContaining(staffDto.email),
      );
      expect(events.emitToAdmin).toHaveBeenCalledWith(
        'staff:created',
        expect.objectContaining({
          id: createdUser.user_id,
          email: staffDto.email,
          role: staffDto.role,
        }),
      );
      expect(result).toMatchObject({
        message: 'Staff account successfully created.',
        user: {
          id: createdUser.user_id,
          email: staffDto.email,
          role: staffDto.role,
        },
      });
    });

    it('throws when the employee profile was not created', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(
        makeEmployeeUser({ employee: null }),
      );

      await expect(service.createStaff(staffDto)).rejects.toThrow(
        new InternalServerErrorException(
          'Staff profile was not created successfully.',
        ),
      );
    });
  });

  describe('login', () => {
    it('rejects an unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login(makeLoginDto())).rejects.toThrow(
        new UnauthorizedException('Invalid credentials.'),
      );
    });

    it('rejects a disabled account', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ is_active: false }));

      await expect(service.login(makeLoginDto())).rejects.toThrow(
        new UnauthorizedException(
          'Account is disabled. Please contact the administrator.',
        ),
      );
    });

    it('rejects an incorrect password', async () => {
      const user = makeUser({
        password_hash: await bcrypt.hash('CorrectPassword123!', 10),
      });
      prisma.user.findUnique.mockResolvedValue(user);

      await expect(
        service.login(makeLoginDto({ password: 'WrongPassword123!' })),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials.'));
    });

    it('updates the last login, audits the login, and returns a token', async () => {
      const password = 'Password123!';
      const user = makeUser({
        password_hash: await bcrypt.hash(password, 10),
      });
      prisma.user.findUnique.mockResolvedValue(user);
      (prisma as Record<string, unknown>).auditLog = {
        findFirst: vi.fn().mockResolvedValue({
          log_id: 1,
          details: JSON.stringify({ twoFactor: false }),
        }),
        create: vi.fn(),
        update: vi.fn(),
      };

      const result = await service.login(makeLoginDto({ password }));

      const updateArgs = prisma.user.update.mock.calls[0]?.[0] as unknown as {
        where: { user_id: number };
        data: { last_login_at: Date };
      };
      expect(updateArgs.where).toEqual({ user_id: user.user_id });
      expect(updateArgs.data.last_login_at).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        user.user_id,
        'USER_LOGIN',
        expect.stringContaining(user.email),
      );
      expect(result.access_token).toBe('signed-access-token');
      expect(result.user).toMatchObject({
        id: user.user_id,
        email: user.email,
        role: Role.SCHOLAR,
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        scholar_profile: user.scholar_profile,
      });
    });

    it('returns employee profile fields for staff accounts', async () => {
      const password = 'Password123!';
      const user = makeEmployeeUser({
        password_hash: await bcrypt.hash(password, 10),
      });
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await service.login(
        makeLoginDto({ email: user.email, password }),
      );

      expect(result.user).toMatchObject({
        id: user.user_id,
        role: Role.COORDINATOR,
        first_name: 'Maria',
        last_name: 'Santos',
        scholar_profile: null,
        employee: user.employee,
      });
    });
  });

  describe('refreshToken', () => {
    it('rejects an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.refreshToken(999)).rejects.toThrow(
        new UnauthorizedException('User not found.'),
      );
    });

    it('rejects a disabled account', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ is_active: false }));

      await expect(service.refreshToken(1)).rejects.toThrow(
        new UnauthorizedException(
          'Account is disabled. Please contact the administrator.',
        ),
      );
    });

    it('re-issues a token with the current role and profile', async () => {
      const user = makeUser({ role: Role.SCHOLAR });
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await service.refreshToken(user.user_id);

      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: user.user_id,
        email: user.email,
        role: Role.SCHOLAR,
      });
      expect(result.user).toMatchObject({
        id: user.user_id,
        email: user.email,
        role: Role.SCHOLAR,
      });
    });
  });

  describe('forgotPassword', () => {
    it('returns a generic message for unknown emails without sending mail', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword({
        email: 'missing@example.com',
      });

      expect(result.message).toContain('If an account exists');
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('returns a generic message for disabled accounts without sending mail', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ is_active: false }));

      const result = await service.forgotPassword({
        email: 'scholar@example.com',
      });

      expect(result.message).toContain('If an account exists');
      expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('signs a 30-minute reset token and emails the scholar', async () => {
      const user = makeUser({ password_hash: 'abcdefghijklmnop' });
      prisma.user.findUnique.mockResolvedValue(user);
      jwt.signAsync.mockResolvedValue('reset-token');

      const result = await service.forgotPassword({
        email: '  SCHOLAR@EXAMPLE.COM ',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'scholar@example.com' },
        include: { scholar_profile: true, employee: true },
      });
      expect(jwt.signAsync).toHaveBeenCalledWith(
        {
          sub: user.user_id,
          email: user.email,
          type: 'PASSWORD_RESET',
          h: 'abcdefghij',
        },
        { expiresIn: '30m' },
      );
      expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(user.email, {
        userName: 'Juan',
        resetUrl: 'https://viascholar.test/reset-password?token=reset-token',
        expiresInMinutes: 30,
      });
      expect(audit.log).toHaveBeenCalledWith(
        user.user_id,
        'PASSWORD_RESET_REQUESTED',
        expect.stringContaining(user.email),
      );
      expect(result.message).toContain('If an account exists');
    });

    it('uses the employee name for staff password resets', async () => {
      const user = makeEmployeeUser();
      prisma.user.findUnique.mockResolvedValue(user);
      jwt.signAsync.mockResolvedValue('staff-reset-token');

      await service.forgotPassword({ email: user.email });

      expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(
        user.email,
        expect.objectContaining({ userName: 'Maria' }),
      );
    });
  });

  describe('resetPassword', () => {
    it('rejects an invalid or expired token', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(
        service.resetPassword({
          token: 'bad-token',
          new_password: 'NewPass123!',
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'The password reset link is invalid or has expired. Please request a new one.',
        ),
      );
    });

    it('rejects a token that is not a password-reset token', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: 1,
        email: 'scholar@example.com',
        type: 'ACCESS_TOKEN',
        h: 'abcdefghij',
      });

      await expect(
        service.resetPassword({
          token: 'access-token',
          new_password: 'NewPass123!',
        }),
      ).rejects.toThrow(
        new BadRequestException('Invalid password reset token.'),
      );
    });

    it('rejects a token for a missing user', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: 999,
        email: 'missing@example.com',
        type: 'PASSWORD_RESET',
        h: 'abcdefghij',
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          token: 'reset-token',
          new_password: 'NewPass123!',
        }),
      ).rejects.toThrow(new BadRequestException('User not found.'));
    });

    it('rejects an already-used reset token', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: 1,
        email: 'scholar@example.com',
        type: 'PASSWORD_RESET',
        h: 'stale-hash',
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ password_hash: 'abcdefghijklmnop' }),
      );

      await expect(
        service.resetPassword({
          token: 'reset-token',
          new_password: 'NewPass123!',
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'This password reset link has already been used. Please request a new one.',
        ),
      );
    });

    it('hashes and stores the new password, then audits the reset', async () => {
      const user = makeUser({ password_hash: 'abcdefghijklmnop' });
      jwt.verifyAsync.mockResolvedValue({
        sub: user.user_id,
        email: user.email,
        type: 'PASSWORD_RESET',
        h: 'abcdefghij',
      });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.user.update.mockResolvedValue(user);

      const result = await service.resetPassword({
        token: 'reset-token',
        new_password: 'NewPass123!',
      });

      const updateArgs = prisma.user.update.mock.calls[0]?.[0] as unknown as {
        where: { user_id: number };
        data: { password_hash: string };
      };

      expect(updateArgs.where).toEqual({ user_id: user.user_id });
      expect(updateArgs.data.password_hash).not.toBe('NewPass123!');
      await expect(
        bcrypt.compare('NewPass123!', updateArgs.data.password_hash),
      ).resolves.toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        user.user_id,
        'PASSWORD_RESET_COMPLETED',
        expect.stringContaining(user.email),
      );
      expect(result).toEqual({
        message:
          'Your password has been successfully reset. You can now log in.',
      });
    });
  });

  describe('googleLogin', () => {
    it('auto-registers a new applicant from a direct email credential', async () => {
      const createdUser = makeUser({
        user_id: 30,
        email: 'newgoogle@example.com',
        role: Role.APPLICANT,
        scholar_profile: {
          profile_id: 300,
          first_name: 'newgoogle',
          last_name: '',
          bio: null,
          avatar_url: null,
          banner_url: null,
        },
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(createdUser);

      const result = await service.googleLogin({
        credential: 'NEWGOOGLE@example.com',
      });

      const createArgs = prisma.user.create.mock.calls[0]?.[0] as unknown as {
        data: {
          email: string;
          password_hash: string;
          role: string;
          is_active: boolean;
          scholar_profile: {
            create: {
              first_name: string;
              last_name: string;
              phone_number: string;
            };
          };
        };
      };

      expect(createArgs.data.email).toBe('newgoogle@example.com');
      expect(createArgs.data.role).toBe(Role.APPLICANT);
      expect(createArgs.data.is_active).toBe(true);
      expect(createArgs.data.password_hash.length).toBeGreaterThan(20);
      expect(createArgs.data.scholar_profile.create).toMatchObject({
        first_name: 'newgoogle',
        last_name: '',
        phone_number: '',
      });
      expect(audit.log).toHaveBeenCalledWith(
        createdUser.user_id,
        'GOOGLE_REGISTER',
        expect.stringContaining(createdUser.email),
      );
      expect(events.emitToAdmin).toHaveBeenCalledWith(
        'user:created',
        expect.objectContaining({
          userId: createdUser.user_id,
          email: createdUser.email,
        }),
      );
      expect(result.access_token).toBe('signed-access-token');
      expect(result.user.role).toBe(Role.APPLICANT);
    });

    it('logs an existing active user in and updates last_login_at', async () => {
      const existingUser = makeUser({
        user_id: 31,
        email: 'returninggoogle@example.com',
      });
      const updatedUser = makeUser({
        ...existingUser,
        last_login_at: new Date(),
      });
      prisma.user.findUnique.mockResolvedValue(existingUser);
      prisma.user.update.mockResolvedValue(updatedUser);

      const result = await service.googleLogin({
        credential: 'returninggoogle@example.com',
      });

      const updateArgs = prisma.user.update.mock.calls[0]?.[0] as unknown as {
        where: { user_id: number };
        data: { last_login_at: Date };
        include: { scholar_profile: boolean; employee: boolean };
      };
      expect(updateArgs.where).toEqual({ user_id: existingUser.user_id });
      expect(updateArgs.data.last_login_at).toBeInstanceOf(Date);
      expect(updateArgs.include).toEqual({
        scholar_profile: true,
        employee: true,
      });
      expect(audit.log).toHaveBeenCalledWith(
        existingUser.user_id,
        'GOOGLE_LOGIN',
        expect.stringContaining(existingUser.email),
      );
      expect(result.user).toMatchObject({
        id: existingUser.user_id,
        email: existingUser.email,
      });
    });

    it('rejects a deactivated Google account', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ email: 'disabledgoogle@example.com', is_active: false }),
      );

      await expect(
        service.googleLogin({ credential: 'disabledgoogle@example.com' }),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Your account has been deactivated. Please contact the administrator.',
        ),
      );
    });

    it('verifies a Google ID token through the OAuth2 client when configured', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'GOOGLE_CLIENT_ID' ? 'test-client-id' : undefined,
      );
      const verifyIdToken = vi
        .spyOn(google.auth.OAuth2.prototype, 'verifyIdToken')
        .mockResolvedValue({
          getPayload: () => ({
            email: 'oauth.client@example.com',
            given_name: 'OAuth',
            family_name: 'Client',
            picture: 'https://google.test/oauth.png',
          }),
        } as never);

      const createdUser = makeUser({
        user_id: 33,
        email: 'oauth.client@example.com',
        role: Role.APPLICANT,
        scholar_profile: {
          profile_id: 330,
          first_name: 'OAuth',
          last_name: 'Client',
          bio: null,
          avatar_url: 'https://google.test/oauth.png',
          banner_url: null,
        },
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(createdUser);

      const result = await service.googleLogin({
        credential: 'header.payload.signature',
      });

      expect(verifyIdToken).toHaveBeenCalledWith({
        idToken: 'header.payload.signature',
        audience: 'test-client-id',
      });
      expect(prisma.user.create).toHaveBeenCalled();
      expect(result.user).toMatchObject({
        email: 'oauth.client@example.com',
        first_name: 'OAuth',
        last_name: 'Client',
        avatar_url: 'https://google.test/oauth.png',
      });
    });

    it('rejects an OAuth2 payload without an email', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'GOOGLE_CLIENT_ID' ? 'test-client-id' : undefined,
      );
      vi.spyOn(google.auth.OAuth2.prototype, 'verifyIdToken').mockResolvedValue(
        {
          getPayload: () => undefined,
        } as never,
      );

      await expect(
        service.googleLogin({ credential: 'header.payload.signature' }),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Google authentication failed. Please try again.',
        ),
      );

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('verifies a Google ID token through the tokeninfo fallback', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            email: 'verified.google@example.com',
            given_name: 'Verified',
            family_name: 'Google',
            picture: 'https://google.test/photo.png',
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const createdUser = makeUser({
        user_id: 32,
        email: 'verified.google@example.com',
        role: Role.APPLICANT,
        scholar_profile: {
          profile_id: 320,
          first_name: 'Verified',
          last_name: 'Google',
          bio: null,
          avatar_url: 'https://google.test/photo.png',
          banner_url: null,
        },
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(createdUser);

      const result = await service.googleLogin({
        credential: 'header.payload.signature',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/tokeninfo?id_token=header.payload.signature',
      );
      expect(prisma.user.create).toHaveBeenCalled();
      expect(result.user).toMatchObject({
        email: 'verified.google@example.com',
        first_name: 'Verified',
        last_name: 'Google',
      });
    });

    it('rejects a Google token when verification fails', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        service.googleLogin({ credential: 'header.payload.signature' }),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Google authentication failed. Please try again.',
        ),
      );

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a Google response without an email', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ given_name: 'NoEmail' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        service.googleLogin({ credential: 'header.payload.signature' }),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Google authentication failed. Please try again.',
        ),
      );
    });
  });

  describe('MFA registration, login, SMS channel switch, Google OAuth, and remember device', () => {
    let mfaService: AuthService;
    let mfaPrisma: {
      user: {
        findUnique: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
      scholarProfile: { findFirst: ReturnType<typeof vi.fn> };
      auditLog: {
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
    };
    let mfaMail: {
      sendPasswordResetEmail: ReturnType<typeof vi.fn>;
      sendTwoFactorOtpEmail: ReturnType<typeof vi.fn>;
    };
    let mfaSms: {
      sendOtpSms: ReturnType<typeof vi.fn>;
    };
    let mfaAudit: { log: ReturnType<typeof vi.fn> };
    let storedSettingsDetails: string | null;

    beforeEach(async () => {
      storedSettingsDetails = null;
      mfaPrisma = {
        user: {
          findUnique: vi.fn(),
          findFirst: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
        scholarProfile: {
          findFirst: vi.fn(),
        },
        auditLog: {
          findFirst: vi
            .fn()
            .mockImplementation(() =>
              Promise.resolve(
                storedSettingsDetails
                  ? { log_id: 101, details: storedSettingsDetails }
                  : null,
              ),
            ),
          create: vi
            .fn()
            .mockImplementation(({ data }: { data: { details: string } }) => {
              storedSettingsDetails = data.details;
              return Promise.resolve({ log_id: 101, ...data });
            }),
          update: vi
            .fn()
            .mockImplementation(({ data }: { data: { details: string } }) => {
              storedSettingsDetails = data.details;
              return Promise.resolve({ log_id: 101, ...data });
            }),
        },
      };
      mfaMail = {
        sendPasswordResetEmail: vi.fn(),
        sendTwoFactorOtpEmail: vi.fn().mockResolvedValue({ simulated: true }),
      };
      mfaSms = {
        sendOtpSms: vi.fn().mockResolvedValue({ simulated: true }),
      };
      mfaAudit = { log: vi.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuthService,
          { provide: PrismaService, useValue: mfaPrisma },
          {
            provide: JwtService,
            useValue: {
              signAsync: vi.fn().mockResolvedValue('signed-access-token'),
            },
          },
          { provide: AuditService, useValue: mfaAudit },
          {
            provide: EventsGateway,
            useValue: { emitGlobalNotification: vi.fn() },
          },
          { provide: MailService, useValue: mfaMail },
          {
            provide: ConfigService,
            useValue: {
              get: vi.fn((key: string) =>
                key === 'JWT_SECRET' ? 'test-jwt-secret' : undefined,
              ),
            },
          },
          { provide: SmsService, useValue: mfaSms },
        ],
      }).compile();

      mfaService = module.get<AuthService>(AuthService);
    });

    it('defaults new scholar registration to EMAIL_OTP, allows switching to SMS_OTP via Novu, and issues trusted_device_token', async () => {
      mfaPrisma.user.findUnique.mockResolvedValueOnce(null);
      mfaPrisma.scholarProfile.findFirst.mockResolvedValue(null);
      const createdUser = makeUser({
        email: 'newstudent@example.com',
        role: Role.APPLICANT,
        scholar_profile: {
          profile_id: 10,
          user_id: 1,
          first_name: 'Juan',
          last_name: 'Dela Cruz',
          phone_number: '09171234567',
        },
      });
      mfaPrisma.user.create.mockResolvedValue(createdUser);

      const regResult = (await mfaService.registerScholar(
        makeRegisterDto({
          email: 'newstudent@example.com',
          phone_number: '09171234567',
        }),
      )) as Record<string, unknown>;

      expect(regResult.mfa_required).toBe(true);
      expect(regResult.mfa_method).toBe('EMAIL_OTP');
      expect(regResult.available_methods).toEqual(['EMAIL_OTP', 'SMS_OTP']);
      expect(mfaMail.sendTwoFactorOtpEmail).toHaveBeenCalledTimes(1);

      mfaPrisma.user.findUnique.mockResolvedValue(createdUser);
      const smsChallenge = await mfaService.sendMfaChallenge({
        mfa_token: String(regResult.mfa_token),
        method: 'SMS_OTP',
      });

      expect(smsChallenge.mfa_method).toBe('SMS_OTP');
      const smsCode = (mfaSms.sendOtpSms.mock.calls[0][1] as { code: string })
        .code;
      expect(smsCode).toMatch(/^\d{6}$/);
      expect(mfaSms.sendOtpSms).toHaveBeenCalledWith(
        '09171234567',
        expect.objectContaining({
          code: smsCode,
          purpose: 'AUTH_MFA',
        }),
      );

      const verified = await mfaService.verifyMfaChallenge({
        mfa_token: String(regResult.mfa_token),
        code: smsCode,
        method: 'SMS_OTP',
        remember_device: true,
      });

      expect(verified.access_token).toBe('signed-access-token');
      expect(typeof verified.trusted_device_token).toBe('string');
      expect(mfaAudit.log).toHaveBeenCalledWith(
        createdUser.user_id,
        'SCHOLAR_MFA_VERIFIED',
        expect.stringContaining('SMS_OTP'),
      );
    });

    it('requires MFA by default on Email+Password login and skips MFA for remembered devices', async () => {
      const password = 'Password123!';
      const baseUser = makeUser();
      const user = makeUser({
        password_hash: await bcrypt.hash(password, 10),
        scholar_profile: {
          ...baseUser.scholar_profile,
          phone_number: '09171234567',
        },
      });
      mfaPrisma.user.findUnique.mockResolvedValue(user);

      const loginRes = (await mfaService.login(
        makeLoginDto({ email: user.email, password }),
      )) as Record<string, unknown>;

      expect(loginRes.mfa_required).toBe(true);
      expect(loginRes.mfa_method).toBe('EMAIL_OTP');
      expect(loginRes.available_methods).toEqual(['EMAIL_OTP']);
      await expect(
        mfaService.sendMfaChallenge({
          mfa_token: String(loginRes.mfa_token),
          method: 'SMS_OTP',
        }),
      ).rejects.toThrow(BadRequestException);

      const emailCode = (
        mfaMail.sendTwoFactorOtpEmail.mock.calls[0][1] as { code: string }
      ).code;
      expect(emailCode).toMatch(/^\d{6}$/);

      const verified = await mfaService.verifyMfaChallenge({
        mfa_token: String(loginRes.mfa_token),
        code: emailCode,
        method: 'EMAIL_OTP',
        remember_device: true,
      });

      expect(typeof verified.trusted_device_token).toBe('string');

      const rememberedLogin = (await mfaService.login(
        makeLoginDto({
          email: user.email,
          password,
          trusted_device_token: verified.trusted_device_token,
        }),
      )) as Record<string, unknown>;

      expect(rememberedLogin.mfa_required).toBeUndefined();
      expect(rememberedLogin.access_token).toBe('signed-access-token');
    });

    it('skips redundant EMAIL_OTP on Google OAuth while enforcing SMS_OTP and AUTHENTICATOR_APP unless trusted', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              email: 'google.scholar@example.com',
              given_name: 'Google',
              family_name: 'Scholar',
            }),
        }),
      );

      const googleUser = makeUser({
        user_id: 55,
        email: 'google.scholar@example.com',
        scholar_profile: {
          profile_id: 55,
          user_id: 55,
          first_name: 'Google',
          last_name: 'Scholar',
          phone_number: '09171234567',
        },
      });
      mfaPrisma.user.findUnique.mockResolvedValue(googleUser);
      mfaPrisma.user.update.mockResolvedValue(googleUser);

      // Default is EMAIL_OTP -> skipped on Google login
      const defaultGoogleRes = (await mfaService.googleLogin({
        credential: 'h.p.s',
      })) as Record<string, unknown>;
      expect(defaultGoogleRes.mfa_required).toBeUndefined();
      expect(mfaMail.sendTwoFactorOtpEmail).not.toHaveBeenCalled();

      // When user explicitly chose SMS_OTP -> enforced on untrusted device
      storedSettingsDetails = JSON.stringify({
        twoFactor: true,
        twoFactorMethod: 'SMS_OTP',
      });
      const smsGoogleRes = (await mfaService.googleLogin({
        credential: 'h.p.s',
      })) as Record<string, unknown>;
      expect(smsGoogleRes.mfa_required).toBe(true);
      expect(smsGoogleRes.mfa_method).toBe('SMS_OTP');
      expect(mfaSms.sendOtpSms).toHaveBeenCalledTimes(1);

      // When user configured AUTHENTICATOR_APP -> enforced on untrusted device, bypassed once remembered
      const totpSecret = 'JBSWY3DPEHPK3PXP';
      storedSettingsDetails = JSON.stringify({
        twoFactor: true,
        twoFactorMethod: 'AUTHENTICATOR_APP',
        twoFactorSecret: totpSecret,
      });
      const totpGoogleRes = (await mfaService.googleLogin({
        credential: 'h.p.s',
      })) as Record<string, unknown>;
      expect(totpGoogleRes.mfa_required).toBe(true);
      expect(totpGoogleRes.mfa_method).toBe('AUTHENTICATOR_APP');

      const verifiedTotp = await mfaService.verifyMfaChallenge({
        mfa_token: String(totpGoogleRes.mfa_token),
        code: generateTotpCode(totpSecret),
        method: 'AUTHENTICATOR_APP',
        remember_device: true,
      });
      expect(typeof verifiedTotp.trusted_device_token).toBe('string');

      const trustedGoogleRes = (await mfaService.googleLogin({
        credential: 'h.p.s',
        trusted_device_token: signTrustedDeviceToken(55, 'test-jwt-secret'),
      })) as Record<string, unknown>;
      expect(trustedGoogleRes.mfa_required).toBeUndefined();
    });
  });

  describe('optional name/gender fields and DB column settings', () => {
    it('persists middle_name, suffix, and gender on registerScholar and createStaff when provided', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.scholarProfile.findFirst.mockResolvedValue(null);
      const createdScholar = makeUser({
        user_id: 88,
        email: 'ana@example.com',
        role: Role.APPLICANT,
        scholar_profile: {
          profile_id: 880,
          first_name: 'Ana',
          middle_name: 'Reyes',
          last_name: 'Santos',
          suffix: 'Jr.',
          gender: 'Female',
          phone_number: '09171234567',
          bio: null,
          avatar_url: null,
          banner_url: null,
        },
      });
      prisma.user.create.mockResolvedValue(createdScholar);
      jwt.signAsync.mockResolvedValue('jwt-token');

      const regResult = await service.registerScholar({
        email: 'ana@example.com',
        password: 'Password1!',
        first_name: 'Ana',
        middle_name: '  Reyes  ',
        last_name: 'Santos',
        suffix: 'Jr.',
        gender: 'Female',
        phone_number: '09171234567',
      });

      const scholarCreateArgs = prisma.user.create.mock.calls[0]?.[0] as {
        data: { scholar_profile: { create: Record<string, unknown> } };
      };
      expect(scholarCreateArgs.data.scholar_profile.create).toEqual({
        first_name: 'Ana',
        middle_name: 'Reyes',
        last_name: 'Santos',
        suffix: 'Jr.',
        gender: 'Female',
        phone_number: '09171234567',
      });
      expect(regResult.user).toMatchObject({
        first_name: 'Ana',
        middle_name: 'Reyes',
        last_name: 'Santos',
        suffix: 'Jr.',
        gender: 'Female',
      });

      const createdStaff = makeUser({
        user_id: 89,
        email: 'staff2@example.com',
        role: Role.COORDINATOR,
        scholar_profile: null,
        employee: {
          employee_id: 89,
          first_name: 'Jose',
          middle_name: 'Cruz',
          last_name: 'Diaz',
          suffix: 'III',
          gender: 'Male',
          title: 'Coordinator',
          department: 'Scholarships',
        },
      });
      prisma.user.create.mockResolvedValue(createdStaff);

      await service.createStaff({
        email: 'staff2@example.com',
        password: 'Password1!',
        role: Role.COORDINATOR,
        first_name: 'Jose',
        middle_name: 'Cruz',
        last_name: 'Diaz',
        suffix: 'III',
        gender: 'Male',
        title: 'Coordinator',
        department: 'Scholarships',
      });

      const staffCreateArgs = prisma.user.create.mock.calls[1]?.[0] as {
        data: { employee: { create: Record<string, unknown> } };
      };
      expect(staffCreateArgs.data.employee.create).toEqual({
        first_name: 'Jose',
        middle_name: 'Cruz',
        last_name: 'Diaz',
        suffix: 'III',
        gender: 'Male',
        title: 'Coordinator',
        department: 'Scholarships',
      });
    });

    it('uses User two_factor_enabled column during login even without audit settings row', async () => {
      const passwordHash = await bcrypt.hash('Password1!', 10);
      const userWithDisabledMfa = makeUser({
        password_hash: passwordHash,
        two_factor_enabled: false,
        two_factor_method: null,
      });
      prisma.user.findUnique.mockResolvedValue(userWithDisabledMfa);
      prisma.user.update.mockResolvedValue(userWithDisabledMfa);
      jwt.signAsync.mockResolvedValue('direct-login-token');

      const result = (await service.login({
        email: userWithDisabledMfa.email,
        password: 'Password1!',
      })) as Record<string, unknown>;

      expect(result.mfa_required).toBeUndefined();
      expect(result.access_token).toBe('direct-login-token');
    });
  });
});
