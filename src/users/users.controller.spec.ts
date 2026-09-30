import { jest } from '@jest/globals';
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
            findAll: jest.fn(),
            findOne: jest.fn(),
            updateStatus: jest.fn(),
            resetPassword: jest.fn(),
            getAdminDashboardSummary: jest.fn(),
            getCoordinatorDashboardSummary: jest.fn(),
            getGrantorDashboardSummary: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            getLogs: jest.fn(),
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
