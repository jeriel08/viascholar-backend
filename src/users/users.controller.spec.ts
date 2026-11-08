import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AuditService } from '../audit/audit.service.js';

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findAll: vi.fn(),
            findOne: vi.fn(),
            updateStatus: vi.fn(),
            resetPassword: vi.fn(),
            getAdminDashboardSummary: vi.fn(),
            getCoordinatorDashboardSummary: vi.fn(),
            getGrantorDashboardSummary: vi.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            getLogs: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
