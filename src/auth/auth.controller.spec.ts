import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ProfileService } from './profile.service.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { RegisterScholarDto } from './dto/register-scholar.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import type { ResetPasswordDto } from './dto/reset-password.dto.js';
import type { GoogleLoginDto } from './dto/google-login.dto.js';
import type { CreateStaffDto } from './dto/create-staff.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';

const createAuthServiceMock = () => ({
  registerScholar: vi.fn(),
  createStaff: vi.fn(),
  login: vi.fn(),
  refreshToken: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
  googleLogin: vi.fn(),
});

const createProfileServiceMock = () => ({
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  uploadBanner: vi.fn(),
  getUserSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  initiateTwoFactorSetup: vi.fn(),
  verifyTwoFactorSetup: vi.fn(),
  changePassword: vi.fn(),
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: ReturnType<typeof createAuthServiceMock>;
  let profileService: ReturnType<typeof createProfileServiceMock>;

  beforeEach(async () => {
    authService = createAuthServiceMock();
    profileService = createProfileServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: ProfileService, useValue: profileService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates scholar registration to AuthService', async () => {
    const dto: RegisterScholarDto = {
      email: 'new@example.com',
      password: 'Password123!',
      first_name: 'New',
      last_name: 'Scholar',
      phone_number: '09171234567',
    };
    authService.registerScholar.mockResolvedValue({ access_token: 'token' });

    const result = await controller.registerScholar(dto);

    expect(authService.registerScholar).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ access_token: 'token' });
  });

  it('delegates login to AuthService', async () => {
    const dto: LoginDto = {
      email: 'scholar@example.com',
      password: 'Password123!',
    };
    authService.login.mockResolvedValue({ access_token: 'token' });

    const result = await controller.login(dto);

    expect(authService.login).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ access_token: 'token' });
  });

  it('delegates forgot-password requests to AuthService', async () => {
    const dto: ForgotPasswordDto = {
      email: 'scholar@example.com',
    };
    authService.forgotPassword.mockResolvedValue({ message: 'sent' });

    const result = await controller.forgotPassword(dto);

    expect(authService.forgotPassword).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ message: 'sent' });
  });

  it('delegates password resets to AuthService', async () => {
    const dto: ResetPasswordDto = {
      token: 'reset-token',
      new_password: 'NewPass123!',
    };
    authService.resetPassword.mockResolvedValue({ message: 'reset' });

    const result = await controller.resetPassword(dto);

    expect(authService.resetPassword).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ message: 'reset' });
  });

  it('delegates Google login to AuthService', async () => {
    const dto: GoogleLoginDto = { credential: 'google-token' };
    authService.googleLogin.mockResolvedValue({ access_token: 'token' });

    const result = await controller.googleLogin(dto);

    expect(authService.googleLogin).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ access_token: 'token' });
  });

  it('delegates staff creation to AuthService', async () => {
    const dto: CreateStaffDto = {
      email: 'coordinator@example.com',
      password: 'Password123!',
      role: Role.COORDINATOR,
      first_name: 'Maria',
      last_name: 'Santos',
    };
    authService.createStaff.mockResolvedValue({ message: 'created' });

    const result = await controller.createStaff(dto);

    expect(authService.createStaff).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ message: 'created' });
  });

  it('requires the ADMIN role for staff creation', () => {
    const handler = Object.getOwnPropertyDescriptor(
      AuthController.prototype,
      'createStaff',
    )?.value as (...args: unknown[]) => unknown;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    expect(roles).toEqual([Role.ADMIN]);
  });

  it('returns the authenticated user from getProfile', () => {
    const req = {
      user: { user_id: 42, email: 'scholar@example.com', role: Role.SCHOLAR },
    };

    expect(controller.getProfile(req)).toBe(req.user);
  });

  it('delegates token refresh to AuthService using the current user id', async () => {
    const req = { user: { user_id: 42 } };
    authService.refreshToken.mockResolvedValue({ access_token: 'fresh-token' });

    const result = await controller.refreshToken(req);

    expect(authService.refreshToken).toHaveBeenCalledWith(42);
    expect(result).toEqual({ access_token: 'fresh-token' });
  });

  it('delegates profile updates to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const dto: UpdateProfileDto = { first_name: 'Juan' };
    profileService.updateProfile.mockResolvedValue({ user_id: 42 });

    const result = await controller.updateProfile(req, dto);

    expect(profileService.updateProfile).toHaveBeenCalledWith(42, dto);
    expect(result).toEqual({ user_id: 42 });
  });

  it('delegates avatar uploads to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const file = {
      originalname: 'avatar.png',
    } as unknown as Express.Multer.File;
    profileService.uploadAvatar.mockResolvedValue({ avatar_url: 'url' });

    const result = await controller.uploadAvatar(req, file);

    expect(profileService.uploadAvatar).toHaveBeenCalledWith(42, file);
    expect(result).toEqual({ avatar_url: 'url' });
  });

  it('delegates banner uploads to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const file = {
      originalname: 'banner.png',
    } as unknown as Express.Multer.File;
    profileService.uploadBanner.mockResolvedValue({ banner_url: 'url' });

    const result = await controller.uploadBanner(req, file);

    expect(profileService.uploadBanner).toHaveBeenCalledWith(42, file);
    expect(result).toEqual({ banner_url: 'url' });
  });

  it('delegates fetching settings to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const settings = {
      emailNotifs: true,
      smsNotifs: false,
      forumDigest: true,
      twoFactor: false,
      publicProfile: true,
    };
    profileService.getUserSettings.mockResolvedValue(settings);

    const result = await controller.getMySettings(req);

    expect(profileService.getUserSettings).toHaveBeenCalledWith(42);
    expect(result).toEqual(settings);
  });

  it('delegates updating settings to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const dto = { emailNotifs: false, smsNotifs: true };
    const updated = {
      emailNotifs: false,
      smsNotifs: true,
      forumDigest: true,
      twoFactor: false,
      twoFactorMethod: null,
      publicProfile: true,
      passwordChangedAt: null,
    };
    profileService.updateUserSettings.mockResolvedValue(updated);

    const result = await controller.updateMySettings(req, dto);

    expect(profileService.updateUserSettings).toHaveBeenCalledWith(42, dto);
    expect(result).toEqual(updated);
  });

  it('delegates two-factor setup initiation to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const dto = { method: 'EMAIL_OTP' as const };
    const setupRes = {
      method: 'EMAIL_OTP',
      destination: 'scholar@example.com',
      expiresInMinutes: 10,
      simulated: true,
      simulationCode: '123456',
    };
    profileService.initiateTwoFactorSetup.mockResolvedValue(setupRes);

    const result = await controller.setupTwoFactor(req, dto);

    expect(profileService.initiateTwoFactorSetup).toHaveBeenCalledWith(42, dto);
    expect(result).toEqual(setupRes);
  });

  it('delegates two-factor verification to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const dto = { method: 'AUTHENTICATOR_APP' as const, code: '654321' };
    const verifiedSettings = {
      emailNotifs: true,
      smsNotifs: false,
      forumDigest: true,
      twoFactor: true,
      twoFactorMethod: 'AUTHENTICATOR_APP',
      publicProfile: true,
      passwordChangedAt: null,
    };
    profileService.verifyTwoFactorSetup.mockResolvedValue(verifiedSettings);

    const result = await controller.verifyTwoFactor(req, dto);

    expect(profileService.verifyTwoFactorSetup).toHaveBeenCalledWith(42, dto);
    expect(result).toEqual(verifiedSettings);
  });

  it('delegates password change to ProfileService', async () => {
    const req = { user: { user_id: 42 } };
    const dto = {
      current_password: 'OldPassword1!',
      new_password: 'NewPassword2@',
    };
    const response = {
      message: 'Password updated successfully.',
      passwordChangedAt: '2026-11-14T10:00:00.000Z',
    };
    profileService.changePassword.mockResolvedValue(response);

    const result = await controller.changePassword(req, dto);

    expect(profileService.changePassword).toHaveBeenCalledWith(42, dto);
    expect(result).toEqual(response);
  });
});
