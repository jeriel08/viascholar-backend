import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createCacheMock = () => ({ wrap: vi.fn() });

describe('AdminDashboardService', () => {
  let service: AdminDashboardService;
  let prisma: {
    user: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    schoolGradingSystem: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    systemSetting: { findFirst: ReturnType<typeof vi.fn> };
    auditLog: { findMany: ReturnType<typeof vi.fn> };
  };
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = {
      user: { findMany: vi.fn(), count: vi.fn() },
      schoolGradingSystem: { findMany: vi.fn(), count: vi.fn() },
      systemSetting: { findFirst: vi.fn() },
      auditLog: { findMany: vi.fn() },
    };
    cache = createCacheMock();

    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    prisma.schoolGradingSystem.findMany.mockResolvedValue([]);
    prisma.schoolGradingSystem.count.mockResolvedValue(0);
    prisma.systemSetting.findFirst.mockResolvedValue(null);
    prisma.auditLog.findMany.mockResolvedValue([]);
    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<AdminDashboardService>(AdminDashboardService);
  });

  it('caches the summary for 60 seconds and forwards the refresh flag', async () => {
    await service.getAdminDashboardSummary();
    await service.getAdminDashboardSummary(true);

    expect(cache.wrap).toHaveBeenNthCalledWith(
      1,
      'dashboard:admin',
      anyArg(Function),
      60 * 1000,
      false,
    );
    expect(cache.wrap).toHaveBeenNthCalledWith(
      2,
      'dashboard:admin',
      anyArg(Function),
      60 * 1000,
      true,
    );
  });

  it('returns sane zero metrics and defaults when the database is empty', async () => {
    const summary = await service.getAdminDashboardSummary();

    expect(summary.metrics).toEqual({
      totalStaff: 0,
      activeStaff: 0,
      coordinatorCount: 0,
      grantorCount: 0,
      adminCount: 0,
      totalStudents: 0,
      activeScholarsCount: 0,
      applicantCount: 0,
      totalSchools: 0,
      verifiedSchools: 0,
      gradeThreshold: 85,
    });
    expect(summary.staff).toEqual([]);
    expect(summary.schools).toEqual([]);
    expect(summary.settings).toBeNull();
    expect(summary.recentLogs).toEqual([]);
  });

  it('counts students, scholars, applicants, and schools with the expected filters', async () => {
    prisma.user.count
      .mockResolvedValueOnce(150)
      .mockResolvedValueOnce(80)
      .mockResolvedValueOnce(70);
    prisma.schoolGradingSystem.count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(9);

    const summary = await service.getAdminDashboardSummary();

    expect(summary.metrics.totalStudents).toBe(150);
    expect(summary.metrics.activeScholarsCount).toBe(80);
    expect(summary.metrics.applicantCount).toBe(70);
    expect(summary.metrics.totalSchools).toBe(12);
    expect(summary.metrics.verifiedSchools).toBe(9);
    expect(prisma.user.count).toHaveBeenNthCalledWith(1, {
      where: {
        role: { in: ['SCHOLAR', 'APPLICANT'] },
        scholar_profile: { is: { archived_at: null } },
      },
    });
    expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
      where: {
        role: 'SCHOLAR',
        is_active: true,
        scholar_profile: { is: { archived_at: null } },
      },
    });
    expect(prisma.user.count).toHaveBeenNthCalledWith(3, {
      where: {
        role: 'APPLICANT',
        scholar_profile: { is: { archived_at: null } },
      },
    });
    expect(prisma.schoolGradingSystem.count).toHaveBeenNthCalledWith(1);
    expect(prisma.schoolGradingSystem.count).toHaveBeenNthCalledWith(2, {
      where: { is_verified: true },
    });
    expect(prisma.schoolGradingSystem.findMany).toHaveBeenCalledWith({
      orderBy: { school_name: 'asc' },
      take: 5,
    });
  });

  it('aggregates staff totals by role and active state', async () => {
    prisma.user.findMany.mockResolvedValue([
      { user_id: 1, role: 'ADMIN', is_active: true, email: 'a@x' },
      { user_id: 2, role: 'COORDINATOR', is_active: false, email: 'c@x' },
      { user_id: 3, role: 'COORDINATOR', is_active: true, email: 'c2@x' },
      { user_id: 4, role: 'GRANTOR', is_active: false, email: 'g@x' },
    ]);

    const summary = await service.getAdminDashboardSummary();

    expect(summary.metrics).toEqual(
      objectMatching({
        totalStaff: 4,
        activeStaff: 2,
        coordinatorCount: 2,
        grantorCount: 1,
        adminCount: 1,
      }),
    );
  });

  it('maps staff presentation fields with employee details and dates', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        user_id: 1,
        email: 'ada@example.com',
        role: 'ADMIN',
        is_active: true,
        created_at: new Date('2026-01-02T03:04:05.000Z'),
        employee: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          title: 'Director',
          department: 'OSA',
        },
      },
      {
        user_id: 2,
        email: 'coord@example.com',
        role: 'COORDINATOR',
        is_active: false,
        created_at: null,
        employee: null,
      },
      {
        user_id: 3,
        email: 'grant@example.com',
        role: 'GRANTOR',
        is_active: true,
        created_at: new Date('2026-02-03T00:00:00.000Z'),
        employee: { first_name: 'Grace', last_name: 'Hopper' },
      },
    ]);

    const summary = await service.getAdminDashboardSummary();

    expect(summary.staff).toEqual([
      {
        id: 1,
        name: 'Ada Lovelace',
        initials: 'AL',
        email: 'ada@example.com',
        type: 'Admin',
        title: 'Director',
        department: 'OSA',
        phone: '',
        active: true,
        joined: '2026-01-02',
      },
      {
        id: 2,
        name: 'coord@example.com',
        initials: 'U',
        email: 'coord@example.com',
        type: 'Coordinator',
        title: '',
        department: '',
        phone: '',
        active: false,
        joined: '',
      },
      {
        id: 3,
        name: 'Grace Hopper',
        initials: 'GH',
        email: 'grant@example.com',
        type: 'Grantor',
        title: '',
        department: '',
        phone: '',
        active: true,
        joined: '2026-02-03',
      },
    ]);
  });

  it('maps school grading scales with numeric coercion and ISO timestamps', async () => {
    prisma.schoolGradingSystem.findMany.mockResolvedValue([
      {
        school_id: 11,
        school_name: 'University of Mindanao',
        grading_scale: 'NUMERIC_4_POINT',
        passing_grade: '2.0',
        highest_grade: '4.0',
        failing_grade: '1.0',
        is_verified: true,
        special_codes: { INC: 'Incomplete' },
        notes: 'Main campus',
        created_at: new Date('2025-06-01T00:00:00.000Z'),
        updated_at: new Date('2025-07-01T00:00:00.000Z'),
      },
      {
        school_id: 12,
        school_name: 'USP',
        grading_scale: 'NUMERIC_5_POINT',
        passing_grade: 3,
        highest_grade: 1,
        failing_grade: 5,
        is_verified: false,
        special_codes: null,
        notes: null,
        created_at: null,
        updated_at: null,
      },
    ]);

    const summary = await service.getAdminDashboardSummary();

    expect(summary.schools[0]).toEqual({
      school_id: 11,
      school_name: 'University of Mindanao',
      grading_scale: 'NUMERIC_4_POINT',
      passing_grade: 2,
      highest_grade: 4,
      failing_grade: 1,
      is_verified: true,
      special_codes: { INC: 'Incomplete' },
      notes: 'Main campus',
      created_at: '2025-06-01T00:00:00.000Z',
      updated_at: '2025-07-01T00:00:00.000Z',
    });
    expect(summary.schools[1]).toEqual(
      objectMatching({
        special_codes: null,
        created_at: '',
        updated_at: '',
      }),
    );
  });

  it('exposes the configured grade threshold in metrics and settings', async () => {
    prisma.systemSetting.findFirst.mockResolvedValue({
      setting_id: 9,
      grade_threshold: '88.5',
      updated_at: new Date('2026-03-04T00:00:00.000Z'),
      updated_by_user_id: 2,
    });

    const summary = await service.getAdminDashboardSummary();

    expect(summary.metrics.gradeThreshold).toBe(88.5);
    expect(summary.settings).toEqual({
      id: 9,
      grade_retention_threshold: 88.5,
      updated_at: '2026-03-04T00:00:00.000Z',
      updated_by_user_id: 2,
    });
  });

  it('maps recent audit logs with employee names, scholar names, and system fallbacks', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        log_id: 1,
        user_id: 5,
        action: 'LOGIN',
        details: null,
        created_at: new Date('2026-04-01T00:00:00.000Z'),
        user: {
          user_id: 5,
          email: 'staff@example.com',
          role: 'COORDINATOR',
          employee: { first_name: 'Ada', last_name: 'Lovelace' },
          scholar_profile: null,
        },
      },
      {
        log_id: 2,
        user_id: 6,
        action: 'ENROLL',
        details: 'Submitted enrollment',
        created_at: null,
        user: {
          user_id: 6,
          email: 'scholar@example.com',
          role: 'SCHOLAR',
          employee: null,
          scholar_profile: { first_name: 'Ana', last_name: 'Cruz' },
        },
      },
      {
        log_id: 3,
        user_id: 0,
        action: 'SYSTEM_JOB',
        details: '',
        created_at: null,
        user: null,
      },
    ]);

    const summary = await service.getAdminDashboardSummary();

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      take: 6,
      orderBy: { created_at: 'desc' },
      include: {
        user: {
          select: objectMatching({
            user_id: true,
            email: true,
            role: true,
          }),
        },
      },
    });
    expect(summary.recentLogs[0]).toEqual({
      log_id: 1,
      user_id: 5,
      action: 'LOGIN',
      details: '',
      created_at: '2026-04-01T00:00:00.000Z',
      user: {
        user_id: 5,
        email: 'staff@example.com',
        role: 'COORDINATOR',
        first_name: 'Ada',
        last_name: 'Lovelace',
      },
    });
    expect(summary.recentLogs[1]).toEqual(
      objectMatching({
        created_at: '',
        user: objectMatching({
          role: 'SCHOLAR',
          first_name: 'Ana',
          last_name: 'Cruz',
        }),
      }),
    );
    expect(summary.recentLogs[2]).toEqual({
      log_id: 3,
      user_id: 0,
      action: 'SYSTEM_JOB',
      details: '',
      created_at: '',
      user: {
        user_id: 0,
        email: '',
        role: 'SYSTEM',
        first_name: '',
        last_name: '',
      },
    });
  });
});
