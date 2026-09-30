import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { CoordinatorDashboardService } from './services/coordinator-dashboard.service.js';
import { GrantorDashboardService } from './services/grantor-dashboard.service.js';

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: EventsGateway,
          useValue: { emitToAdmin: jest.fn(), emitToUser: jest.fn() },
        },
        {
          provide: AppCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            delPattern: jest.fn(),
            wrap: jest.fn(),
          },
        },
        {
          provide: AdminDashboardService,
          useValue: { getAdminDashboardSummary: jest.fn() },
        },
        {
          provide: CoordinatorDashboardService,
          useValue: { getCoordinatorDashboardSummary: jest.fn() },
        },
        {
          provide: GrantorDashboardService,
          useValue: { getGrantorDashboardSummary: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
