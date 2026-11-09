import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { QueryUsersDto } from './dto/query-users.dto.js';
import type { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import type { AdminResetPasswordDto } from './dto/reset-password.dto.js';

const makeRequest = (userId = 7, role: Role = Role.ADMIN) => ({
  user: { user_id: userId, role },
});

describe('UsersController', () => {
  let controller: UsersController;
  let usersMock: Record<string, ReturnType<typeof vi.fn>>;
  let auditMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    usersMock = {
      findAll: vi.fn(),
      findOne: vi.fn(),
      updateStatus: vi.fn(),
      resetPassword: vi.fn(),
      getAdminDashboardSummary: vi.fn(),
      getCoordinatorDashboardSummary: vi.fn(),
      getGrantorDashboardSummary: vi.fn(),
    };
    auditMock = {
      getLogs: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  describe('delegation', () => {
    it('delegates findAll with the query filters', () => {
      const query = {
        role: Role.SCHOLAR,
        search: 'ana',
      } as QueryUsersDto;

      void controller.findAll(query);

      expect(usersMock.findAll).toHaveBeenCalledWith(query);
    });

    it('defaults audit log pagination to page 1 and limit 50', () => {
      void controller.getAuditLogs();

      expect(auditMock.getLogs).toHaveBeenCalledWith(1, 50);
    });

    it('coerces string pagination values into numbers', () => {
      void controller.getAuditLogs(
        '3' as unknown as number,
        '25' as unknown as number,
      );

      expect(auditMock.getLogs).toHaveBeenCalledWith(3, 25);
    });

    it('requests a forced refresh only when refresh is the string "true"', () => {
      void controller.getAdminDashboard('true');
      void controller.getAdminDashboard('false');
      void controller.getAdminDashboard();

      expect(usersMock.getAdminDashboardSummary).toHaveBeenNthCalledWith(
        1,
        true,
      );
      expect(usersMock.getAdminDashboardSummary).toHaveBeenNthCalledWith(
        2,
        false,
      );
      expect(usersMock.getAdminDashboardSummary).toHaveBeenNthCalledWith(
        3,
        false,
      );
    });

    it('delegates the coordinator dashboard with the authenticated user and refresh flag', () => {
      void controller.getCoordinatorDashboard(makeRequest(12), 'true');
      void controller.getCoordinatorDashboard(makeRequest(12));

      expect(usersMock.getCoordinatorDashboardSummary).toHaveBeenNthCalledWith(
        1,
        12,
        true,
      );
      expect(usersMock.getCoordinatorDashboardSummary).toHaveBeenNthCalledWith(
        2,
        12,
        false,
      );
    });

    it('delegates the grantor dashboard with the authenticated user and refresh flag', () => {
      void controller.getGrantorDashboard(makeRequest(15), 'true');
      void controller.getGrantorDashboard(makeRequest(15));

      expect(usersMock.getGrantorDashboardSummary).toHaveBeenNthCalledWith(
        1,
        15,
        true,
      );
      expect(usersMock.getGrantorDashboardSummary).toHaveBeenNthCalledWith(
        2,
        15,
        false,
      );
    });

    it('delegates findOne with the parsed user id', () => {
      void controller.findOne(42);

      expect(usersMock.findOne).toHaveBeenCalledWith(42);
    });

    it('delegates updateStatus with the admin, target user, and dto', () => {
      const dto = { is_active: false } as UpdateUserStatusDto;

      void controller.updateStatus(makeRequest(1), 42, dto);

      expect(usersMock.updateStatus).toHaveBeenCalledWith(1, 42, dto);
    });

    it('delegates resetPassword with the admin, target user, and dto', () => {
      const dto: AdminResetPasswordDto = {
        new_password: 'NewPassword123!',
      };

      void controller.resetPassword(makeRequest(2), 42, dto);

      expect(usersMock.resetPassword).toHaveBeenCalledWith(2, 42, dto);
    });
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = UsersController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('gates the user listing and user detail endpoints to admin and coordinator', () => {
      expect(rolesFor(handlerFor('findAll'))).toEqual([
        Role.ADMIN,
        Role.COORDINATOR,
      ]);
      expect(rolesFor(handlerFor('findOne'))).toEqual([
        Role.ADMIN,
        Role.COORDINATOR,
      ]);
    });

    it('gates audit logs and admin dashboard to admin only', () => {
      expect(rolesFor(handlerFor('getAuditLogs'))).toEqual([Role.ADMIN]);
      expect(rolesFor(handlerFor('getAdminDashboard'))).toEqual([Role.ADMIN]);
    });

    it('allows coordinators and admins to read the coordinator dashboard', () => {
      expect(rolesFor(handlerFor('getCoordinatorDashboard'))).toEqual([
        Role.COORDINATOR,
        Role.ADMIN,
      ]);
    });

    it('allows grantors and admins to read the grantor dashboard', () => {
      expect(rolesFor(handlerFor('getGrantorDashboard'))).toEqual([
        Role.GRANTOR,
        Role.ADMIN,
      ]);
    });

    it('gates status changes and password resets to admin only', () => {
      expect(rolesFor(handlerFor('updateStatus'))).toEqual([Role.ADMIN]);
      expect(rolesFor(handlerFor('resetPassword'))).toEqual([Role.ADMIN]);
    });
  });
});
