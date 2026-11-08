import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from './audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
});
const createEventsMock = () => ({
  emitToAdmin: vi.fn(),
});

const makeAuditEntry = (overrides: Record<string, unknown> = {}) => ({
  audit_log_id: 100,
  user_id: 7,
  action: 'APPLICATION_SUBMITTED',
  details: 'Application submitted',
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  user: {
    user_id: 7,
    email: 'juan@example.com',
    role: 'SCHOLAR',
    scholar_profile: { first_name: 'Juan', last_name: 'Dela Cruz' },
    employee: null,
  },
  ...overrides,
});

describe('AuditService', () => {
  let service: AuditService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let events: ReturnType<typeof createEventsMock>;

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    prisma = createPrismaMock();
    events = createEventsMock();

    prisma.auditLog.create.mockResolvedValue(makeAuditEntry());
    prisma.auditLog.findMany.mockResolvedValue([makeAuditEntry()]);
    prisma.auditLog.count.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('log', () => {
    it('persists the entry and returns it', async () => {
      const result = await service.log(7, 'APPLICATION_SUBMITTED', 'Details');

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          user_id: 7,
          action: 'APPLICATION_SUBMITTED',
          details: 'Details',
        },
        include: objectMatching({
          user: objectMatching({
            select: objectMatching({
              user_id: true,
              email: true,
              role: true,
            }),
          }),
        }),
      });
      expect(result).toEqual(makeAuditEntry());
    });

    it('logs system events with a null user id', async () => {
      await service.log(null, 'SYSTEM_CRON_RUN', 'Nightly job finished');

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: objectMatching({ user_id: null }),
        include: anyArg(Object),
      });
    });

    it('omits details when none are provided', async () => {
      await service.log(7, 'PING');

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          user_id: 7,
          action: 'PING',
          details: undefined,
        },
        include: anyArg(Object),
      });
    });

    it('emits a realtime audit event to staff on success', async () => {
      const entry = makeAuditEntry();
      prisma.auditLog.create.mockResolvedValue(entry);

      await service.log(7, 'APPLICATION_SUBMITTED');

      expect(events.emitToAdmin).toHaveBeenCalledWith('audit:new_log', entry);
    });

    it('returns undefined instead of throwing when persistence fails', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db offline'));

      await expect(
        service.log(7, 'APPLICATION_SUBMITTED'),
      ).resolves.toBeUndefined();
      expect(events.emitToAdmin).not.toHaveBeenCalled();
    });
  });

  describe('getLogs', () => {
    it('returns logs, total, and the requested page metadata', async () => {
      const result = await service.getLogs(2, 10);

      expect(result).toEqual({
        logs: [makeAuditEntry()],
        total: 1,
        page: 2,
        limit: 10,
      });
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        objectMatching({
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.auditLog.count).toHaveBeenCalledWith();
    });

    it('uses sensible pagination defaults', async () => {
      const result = await service.getLogs();

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        objectMatching({
          skip: 0,
          take: 50,
          orderBy: { created_at: 'desc' },
        }),
      );
      expect(result).toEqual(objectMatching({ page: 1, limit: 50 }));
    });

    it('computes the skip offset for deeper pages', async () => {
      await service.getLogs(4, 25);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        objectMatching({
          skip: 75,
          take: 25,
        }),
      );
    });
  });
});
