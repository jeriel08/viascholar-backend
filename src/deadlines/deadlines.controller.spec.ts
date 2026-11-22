import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { DeadlinesController } from './deadlines.controller.js';
import { DeadlinesService } from './deadlines.service.js';

const makeRequest = (userId = 7, role: Role = Role.COORDINATOR) => ({
  user: { user_id: userId, email: 'staff@example.com', role },
});

describe('DeadlinesController', () => {
  let controller: DeadlinesController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      getCompliance: vi.fn(),
      getDeadlineDetailCompliance: vi.fn(),
      sendFollowUp: vi.fn(),
      exemptScholar: vi.fn(),
      removeExemption: vi.fn(),
      getMyDeadlines: vi.fn(),
      listDeadlines: vi.fn(),
      createDeadline: vi.fn(),
      updateDeadline: vi.fn(),
      deleteDeadline: vi.fn(),
      processScheduledReminders: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeadlinesController],
      providers: [{ provide: DeadlinesService, useValue: serviceMock }],
    }).compile();

    controller = module.get<DeadlinesController>(DeadlinesController);
  });

  it('delegates controller methods to DeadlinesService', async () => {
    serviceMock.listDeadlines.mockResolvedValue([]);
    await controller.listDeadlines('2026-2027', '1st Semester', 'ENROLLMENT', 'true', 'true');
    expect(serviceMock.listDeadlines).toHaveBeenCalledWith({
      academic_year: '2026-2027',
      semester: '1st Semester',
      requirement_type: 'ENROLLMENT',
      only_active: true,
      include_summary: true,
    });

    await controller.getCompliance('2026-2027', '1st Semester', 'ALL', 'OVERDUE', '3', 'juan');
    expect(serviceMock.getCompliance).toHaveBeenCalledWith({
      academic_year: '2026-2027',
      semester: '1st Semester',
      requirement_type: 'ALL',
      status: 'OVERDUE',
      school_id: 3,
      search: 'juan',
    });

    await controller.getDeadlineDetailCompliance(5, 'COVERED_ALL', '2', 'ana');
    expect(serviceMock.getDeadlineDetailCompliance).toHaveBeenCalledWith(5, {
      status: 'COVERED_ALL',
      school_id: 2,
      search: 'ana',
    });

    await controller.getMyDeadlines(makeRequest(42, Role.SCHOLAR));
    expect(serviceMock.getMyDeadlines).toHaveBeenCalledWith(42);

    await controller.runScheduledReminders(makeRequest(7, Role.COORDINATOR));
    expect(serviceMock.processScheduledReminders).toHaveBeenCalledWith(
      expect.any(Date),
      7,
    );
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = DeadlinesController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts staff deadline endpoints to ADMIN, GRANTOR, COORDINATOR', () => {
      for (const name of [
        'getCompliance',
        'getDeadlineDetailCompliance',
        'sendFollowUp',
        'exemptScholar',
        'removeExemption',
        'listDeadlines',
        'createDeadline',
        'updateDeadline',
        'deleteDeadline',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.ADMIN,
          Role.GRANTOR,
          Role.COORDINATOR,
        ]);
      }
    });

    it('restricts getMyDeadlines to SCHOLAR and APPLICANT roles', () => {
      expect(rolesFor(handlerFor('getMyDeadlines'))).toEqual([
        Role.SCHOLAR,
        Role.APPLICANT,
      ]);
    });

    it('restricts runScheduledReminders to ADMIN and COORDINATOR roles', () => {
      expect(rolesFor(handlerFor('runScheduledReminders'))).toEqual([
        Role.ADMIN,
        Role.COORDINATOR,
      ]);
    });
  });
});
