import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationsService } from './applications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';

describe('ApplicationsService', () => {
  let service: ApplicationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: MailService,
          useValue: {
            sendApplicationSubmittedStudent: jest.fn(),
            getStaffEmails: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: EventsGateway,
          useValue: {
            emitToStaff: jest.fn(),
            emitToUser: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyStaff: jest.fn(),
            notifyUser: jest.fn(),
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
