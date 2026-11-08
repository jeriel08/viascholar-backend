import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationsService } from './applications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';

describe('ApplicationsService', () => {
  let service: ApplicationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: vi.fn() } },
        {
          provide: MailService,
          useValue: {
            sendApplicationSubmittedStudent: vi.fn(),
            getStaffEmails: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: EventsGateway,
          useValue: {
            emitToStaff: vi.fn(),
            emitToUser: vi.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyStaff: vi.fn(),
            notifyUser: vi.fn(),
          },
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
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
