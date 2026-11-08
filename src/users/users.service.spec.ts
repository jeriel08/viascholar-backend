import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        { provide: AuditService, useValue: { log: vi.fn() } },
        {
          provide: EventsGateway,
          useValue: { emitToAdmin: vi.fn(), emitToUser: vi.fn() },
        },
        {
          provide: AppCacheService,
          useValue: {
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            delPattern: vi.fn(),
            wrap: vi.fn(),
          },
        },
        {
          provide: AdminDashboardService,
          useValue: { getAdminDashboardSummary: vi.fn() },
        },
        {
          provide: CoordinatorDashboardService,
          useValue: { getCoordinatorDashboardSummary: vi.fn() },
        },
        {
          provide: GrantorDashboardService,
          useValue: { getGrantorDashboardSummary: vi.fn() },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
