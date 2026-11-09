import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcrypt';

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { CoordinatorDashboardService } from './services/coordinator-dashboard.service.js';
import { GrantorDashboardService } from './services/grantor-dashboard.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import type { AdminResetPasswordDto } from './dto/reset-password.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let events: {
    emitToAdmin: ReturnType<typeof vi.fn>;
    emitToUser: ReturnType<typeof vi.fn>;
  };
  let cache: { delPattern: ReturnType<typeof vi.fn> };
  let adminDashboard: {
    getAdminDashboardSummary: ReturnType<typeof vi.fn>;
  };
  let coordinatorDashboard: {
    getCoordinatorDashboardSummary: ReturnType<typeof vi.fn>;
  };
  let grantorDashboard: {
    getGrantorDashboardSummary: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    audit = { log: vi.fn() };
    events = { emitToAdmin: vi.fn(), emitToUser: vi.fn() };
    cache = { delPattern: vi.fn() };
    adminDashboard = { getAdminDashboardSummary: vi.fn() };
    coordinatorDashboard = { getCoordinatorDashboardSummary: vi.fn() };
    grantorDashboard = { getGrantorDashboardSummary: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: AppCacheService, useValue: cache },
        { provide: AdminDashboardService, useValue: adminDashboard },
        {
          provide: CoordinatorDashboardService,
          useValue: coordinatorDashboard,
        },
        { provide: GrantorDashboardService, useValue: grantorDashboard },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('queries every user newest-first with the profile projection when no filters are given', async () => {
      const users = [{ user_id: 1 }];
      prisma.user.findMany.mockResolvedValue(users);

      await expect(service.findAll({})).resolves.toBe(users);

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { created_at: 'desc' },
        select: objectMatching({
          user_id: true,
          email: true,
          role: true,
          is_active: true,
          scholar_profile: objectMatching({
            include: objectMatching({
              grade_reports: objectMatching({
                orderBy: { submitted_at: 'desc' },
                take: 1,
              }),
            }),
          }),
          employee: true,
        }),
      });
    });

    it('filters by a single role', async () => {
      await service.findAll({ role: Role.COORDINATOR });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { role: Role.COORDINATOR },
        }),
      );
    });

    it('filters by a comma-separated role list and trims surrounding whitespace', async () => {
      await service.findAll({
        roles: ' APPLICANT, SCHOLAR , ,GRANTOR ',
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { role: { in: ['APPLICANT', 'SCHOLAR', 'GRANTOR'] } },
        }),
      );
    });

    it('ignores a role list that contains only separators', async () => {
      await service.findAll({ roles: ' , , ' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        objectMatching({ where: {} }),
      );
    });

    it('prefers the singular role filter over the role list', async () => {
      await service.findAll({
        role: Role.ADMIN,
        roles: 'SCHOLAR,GRANTOR',
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { role: Role.ADMIN } }),
      );
    });

    it('builds case-insensitive OR search clauses across scholar and employee profiles', async () => {
      await service.findAll({ search: 'ana' });

      const args = prisma.user.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      const or = args.where.OR as Array<Record<string, unknown>>;

      expect(or).toHaveLength(7);
      expect(or).toEqual(
        expect.arrayContaining([
          { email: { contains: 'ana', mode: 'insensitive' } },
          {
            scholar_profile: {
              first_name: { contains: 'ana', mode: 'insensitive' },
            },
          },
          {
            scholar_profile: {
              last_name: { contains: 'ana', mode: 'insensitive' },
            },
          },
          {
            scholar_profile: {
              course_of_study: { contains: 'ana', mode: 'insensitive' },
            },
          },
          {
            scholar_profile: {
              scholarship_track: { contains: 'ana', mode: 'insensitive' },
            },
          },
          {
            employee: {
              first_name: { contains: 'ana', mode: 'insensitive' },
            },
          },
          {
            employee: {
              last_name: { contains: 'ana', mode: 'insensitive' },
            },
          },
        ]),
      );
    });

    it('combines the role filter with the search clauses', async () => {
      await service.findAll({
        role: Role.SCHOLAR,
        search: 'cruz',
      });

      const args = prisma.user.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };

      expect(args.where.role).toBe(Role.SCHOLAR);
      expect(args.where.OR).toHaveLength(7);
    });
  });

  describe('findOne', () => {
    it('returns the matching user with the newest grade report', async () => {
      const user = { user_id: 42, email: 'user@example.com' };
      prisma.user.findUnique.mockResolvedValue(user);

      await expect(service.findOne(42)).resolves.toBe(user);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { user_id: 42 },
        select: objectMatching({
          user_id: true,
          email: true,
          scholar_profile: objectMatching({
            include: objectMatching({
              grade_reports: objectMatching({ take: 1 }),
            }),
          }),
          employee: true,
        }),
      });
    });

    it('throws NotFoundException when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne(404)).rejects.toThrow(
        new NotFoundException('User with ID 404 not found.'),
      );
    });
  });

  describe('updateStatus', () => {
    const dto = (isActive: boolean): UpdateUserStatusDto => ({
      is_active: isActive,
    });

    it('throws NotFoundException before writing when the target user is missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.updateStatus(1, 99, dto(true))).rejects.toThrow(
        new NotFoundException('User with ID 99 not found.'),
      );

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('activates a user, audits it, invalidates dashboards, and notifies both audiences', async () => {
      const updated = { user_id: 99, email: 'u@example.com', is_active: true };
      prisma.user.findUnique.mockResolvedValue({ user_id: 99 });
      prisma.user.update.mockResolvedValue(updated);

      await expect(service.updateStatus(1, 99, dto(true))).resolves.toBe(
        updated,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { user_id: 99 },
        data: { is_active: true },
        select: {
          user_id: true,
          email: true,
          role: true,
          is_active: true,
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'USER_ACTIVATED',
        'Admin (ID: 1) updated User status (ID: 99) to ACTIVE',
      );
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:');
      expect(events.emitToAdmin).toHaveBeenCalledWith('user:status_updated', {
        userId: 99,
        isActive: true,
        user: updated,
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        99,
        'user:status_updated',
        {
          userId: 99,
          isActive: true,
        },
      );
    });

    it('deactivates a user and records the deactivation action', async () => {
      const updated = { user_id: 99, email: 'u@example.com', is_active: false };
      prisma.user.findUnique.mockResolvedValue({ user_id: 99 });
      prisma.user.update.mockResolvedValue(updated);

      await service.updateStatus(5, 99, dto(false));

      expect(prisma.user.update).toHaveBeenCalledWith(
        objectMatching({ data: { is_active: false } }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        5,
        'USER_DEACTIVATED',
        'Admin (ID: 5) updated User status (ID: 99) to INACTIVE',
      );
      expect(events.emitToAdmin).toHaveBeenCalledWith(
        'user:status_updated',
        objectMatching({ isActive: false }),
      );
    });
  });

  describe('resetPassword', () => {
    const dto: AdminResetPasswordDto = {
      new_password: 'NewSecurePassword123!',
    };

    it('throws NotFoundException without hashing when the target user is missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.resetPassword(1, 404, dto)).rejects.toThrow(
        new NotFoundException('User with ID 404 not found.'),
      );

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('stores a bcrypt hash, audits the reset, and notifies both audiences', async () => {
      prisma.user.findUnique.mockResolvedValue({ user_id: 42 });
      prisma.user.update.mockResolvedValue({ user_id: 42 });

      await expect(service.resetPassword(1, 42, dto)).resolves.toEqual({
        message: 'Password for user ID 42 reset successfully.',
      });

      const updateArgs = prisma.user.update.mock.calls[0][0] as {
        where: { user_id: number };
        data: { password_hash: string };
      };

      expect(updateArgs.where).toEqual({ user_id: 42 });
      expect(updateArgs.data.password_hash).not.toBe(dto.new_password);
      await expect(
        bcrypt.compare(dto.new_password, updateArgs.data.password_hash),
      ).resolves.toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        1,
        'USER_PASSWORD_RESET',
        'Admin (ID: 1) reset password for User (ID: 42)',
      );
      expect(events.emitToAdmin).toHaveBeenCalledWith('user:password_reset', {
        userId: 42,
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        42,
        'user:password_reset',
        {
          userId: 42,
        },
      );
    });
  });

  describe('dashboard delegation', () => {
    it('delegates the admin dashboard and preserves the refresh flag', async () => {
      const summary = { metrics: { totalStaff: 3 } };
      adminDashboard.getAdminDashboardSummary.mockResolvedValue(summary);

      await expect(service.getAdminDashboardSummary()).resolves.toBe(summary);
      await service.getAdminDashboardSummary(true);

      expect(adminDashboard.getAdminDashboardSummary).toHaveBeenNthCalledWith(
        1,
        false,
      );
      expect(adminDashboard.getAdminDashboardSummary).toHaveBeenNthCalledWith(
        2,
        true,
      );
    });

    it('delegates the coordinator dashboard scoped to the coordinator user', async () => {
      coordinatorDashboard.getCoordinatorDashboardSummary.mockResolvedValue({});

      await service.getCoordinatorDashboardSummary(12);
      await service.getCoordinatorDashboardSummary(12, true);

      expect(
        coordinatorDashboard.getCoordinatorDashboardSummary,
      ).toHaveBeenNthCalledWith(1, 12, false);
      expect(
        coordinatorDashboard.getCoordinatorDashboardSummary,
      ).toHaveBeenNthCalledWith(2, 12, true);
    });

    it('delegates the grantor dashboard scoped to the grantor user', async () => {
      grantorDashboard.getGrantorDashboardSummary.mockResolvedValue({});

      await service.getGrantorDashboardSummary(15);
      await service.getGrantorDashboardSummary(15, true);

      expect(
        grantorDashboard.getGrantorDashboardSummary,
      ).toHaveBeenNthCalledWith(1, 15, false);
      expect(
        grantorDashboard.getGrantorDashboardSummary,
      ).toHaveBeenNthCalledWith(2, 15, true);
    });
  });

  describe('scholar evaluation delegation', () => {
    it('delegates GWA threshold evaluation with the school grading configuration', () => {
      const config = {
        grading_scale: 'NUMERIC_5_POINT',
        highest_grade: 1.0,
        passing_grade: 3.0,
        failing_grade: 5.0,
      };

      expect(service.evaluateGwaThreshold(1.5, 90, config)).toBe(true);
      expect(service.evaluateGwaThreshold(2.5, 90, config)).toBe(false);
    });

    it('delegates scholar health evaluation and returns the computed standing', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: {
          grading_scale: 'PERCENTAGE_100',
          passing_grade: 75,
        },
      };

      expect(service.evaluateScholarHealth(94, scholar, null, 90)).toBe('good');
      expect(service.evaluateScholarHealth(88, scholar, null, 90)).toBe('warn');
      expect(service.evaluateScholarHealth(70, scholar, null, 90)).toBe('bad');
    });
  });
});
