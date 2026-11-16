import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  SettingsService,
  resolveActiveAcademicTerm,
  validateEnrollmentTermAgainstPolicy,
} from './settings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { Role } from '../generated/prisma/enums.js';

const createPrismaMock = () => ({
  systemSetting: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  schoolGradingSystem: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  employee: {
    findUnique: vi.fn(),
  },
  academicProgram: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  school: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
  emitToAll: vi.fn(),
});
const createCacheMock = () => ({
  wrap: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  delPattern: vi.fn(),
});

const makeSettings = () => ({
  setting_id: 1,
  grade_threshold: '90.00',
  updated_by_user_id: null,
});

const makeSchoolGrading = (overrides: Record<string, unknown> = {}) => ({
  school_id: 10,
  school_name: 'University of Mindanao',
  grading_scale: 'NUMERIC_4_POINT',
  highest_grade: '4.0',
  passing_grade: '2.0',
  failing_grade: '1.0',
  min_grade: '1.0',
  max_grade: '4.0',
  special_codes: { INC: 'Incomplete', DRP: 'Dropped' },
  is_verified: true,
  ...overrides,
});

const makeProgram = (overrides: Record<string, unknown> = {}) => ({
  program_id: 1,
  program_code: 'BSIT',
  program_name: 'BS Information Technology',
  category: 'College',
  description: 'IT program',
  is_active: true,
  ...overrides,
});

const makeSchool = (overrides: Record<string, unknown> = {}) => ({
  school_id: 5,
  school_name: 'University of Mindanao',
  school_code: 'UM',
  address: 'Davao City',
  contact_email: 'registrar@um.edu.ph',
  contact_number: '0917',
  is_active: true,
  scholar_profiles: [{ profile_id: 11 }],
  grading_system: makeSchoolGrading({ school_id: 6 }),
  ...overrides,
});

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

describe('SettingsService', () => {
  let service: SettingsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    // The service logs on init; keep test output tidy.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();
    cache = createCacheMock();

    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    prisma.systemSetting.findFirst.mockResolvedValue(makeSettings());
    prisma.systemSetting.create.mockResolvedValue(makeSettings());
    prisma.systemSetting.update.mockResolvedValue({
      ...makeSettings(),
      grade_threshold: '80.00',
    });
    prisma.schoolGradingSystem.findUnique.mockResolvedValue(
      makeSchoolGrading(),
    );
    prisma.schoolGradingSystem.findFirst.mockResolvedValue(null);
    prisma.schoolGradingSystem.findMany.mockResolvedValue([
      makeSchoolGrading(),
    ]);
    prisma.schoolGradingSystem.create.mockResolvedValue(makeSchoolGrading());
    prisma.schoolGradingSystem.update.mockResolvedValue({
      ...makeSchoolGrading(),
      is_verified: false,
    });
    prisma.schoolGradingSystem.delete.mockResolvedValue(makeSchoolGrading());
    prisma.employee.findUnique.mockResolvedValue({
      employee_id: 3,
      first_name: 'Maria',
      last_name: 'Santos',
    });
    prisma.academicProgram.findFirst.mockResolvedValue(null);
    prisma.academicProgram.findUnique.mockResolvedValue(makeProgram());
    prisma.academicProgram.findMany.mockResolvedValue([makeProgram()]);
    prisma.academicProgram.create.mockResolvedValue(makeProgram());
    prisma.academicProgram.update.mockResolvedValue(makeProgram());
    prisma.academicProgram.delete.mockResolvedValue(makeProgram());
    prisma.school.findUnique.mockResolvedValue(null);
    prisma.school.findMany.mockResolvedValue([makeSchool()]);
    prisma.school.create.mockResolvedValue(makeSchool());
    prisma.school.update.mockResolvedValue(makeSchool());
    prisma.school.delete.mockResolvedValue(makeSchool());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<SettingsService>(SettingsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('creates the default threshold when no settings exist', async () => {
      prisma.systemSetting.findFirst.mockResolvedValue(null);

      await service.onModuleInit();

      expect(prisma.systemSetting.create).toHaveBeenCalledWith({
        data: { grade_threshold: 90.0 },
      });
    });

    it('leaves existing settings untouched', async () => {
      await service.onModuleInit();

      expect(prisma.systemSetting.create).not.toHaveBeenCalled();
    });
  });

  describe('getSettings', () => {
    it('caches the global settings lookup and honors refresh', async () => {
      const result = await service.getSettings(true);

      expect(cache.wrap).toHaveBeenCalledWith(
        'settings:global',
        anyArg(Function),
        5 * 60 * 1000,
        true,
      );
      expect(result).toEqual(makeSettings());
    });

    it('creates default settings when none exist', async () => {
      prisma.systemSetting.findFirst.mockResolvedValueOnce(null);

      await service.getSettings();

      expect(prisma.systemSetting.create).toHaveBeenCalledWith({
        data: { grade_threshold: 90.0 },
      });
    });
  });

  describe('updateSettings', () => {
    it('updates the threshold and invalidates dependent caches', async () => {
      const withNew = { ...makeSettings(), grade_threshold: '80.00' };
      prisma.systemSetting.update.mockResolvedValue(withNew);

      const result = await service.updateSettings(7, {
        grade_threshold: 80,
      });

      expect(prisma.systemSetting.update).toHaveBeenCalledWith({
        where: { setting_id: 1 },
        data: { grade_threshold: 80, updated_by_user_id: 7 },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SETTINGS_UPDATED',
        expect.stringContaining('80%'),
      );
      expect(cache.del).toHaveBeenCalledWith('settings:global');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:');
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'settings:updated',
        withNew,
      );
      expect(events.emitToAll).toHaveBeenCalledWith(
        'settings:updated',
        withNew,
      );
      expect(result).toBe(withNew);
    });
  });

  describe('academic term calendar resolution & strict policy', () => {
    it('keeps Jan-May 2027 inside AY 2026-2027 and automatically rolls over on July 2027', () => {
      const nov2026 = resolveActiveAcademicTerm(
        { ay_rollover_month: 7, strict_active_term_policy: true },
        new Date(2026, 10, 16),
      );
      expect(nov2026.effective_academic_year).toBe('2026-2027');
      expect(nov2026.effective_semester).toBe('1st Semester');

      const jan2027 = resolveActiveAcademicTerm(
        { ay_rollover_month: 7, strict_active_term_policy: true },
        new Date(2027, 0, 15),
      );
      expect(jan2027.effective_academic_year).toBe('2026-2027');
      expect(jan2027.effective_semester).toBe('2nd Semester');

      const may2027 = resolveActiveAcademicTerm(
        { ay_rollover_month: 7, strict_active_term_policy: true },
        new Date(2027, 4, 20),
      );
      expect(may2027.effective_academic_year).toBe('2026-2027');
      expect(may2027.in_transition_window).toBe(true);
      expect(may2027.valid_academic_years).toEqual(['2026-2027', '2027-2028']);

      const jul2027 = resolveActiveAcademicTerm(
        { ay_rollover_month: 7, strict_active_term_policy: true },
        new Date(2027, 6, 1),
      );
      expect(jul2027.effective_academic_year).toBe('2027-2028');
      expect(jul2027.effective_semester).toBe('1st Semester');
    });

    it('honors an active manual override and falls back automatically when expired', () => {
      const activeOverride = resolveActiveAcademicTerm(
        {
          ay_rollover_month: 7,
          manual_academic_year: '2025-2026',
          manual_semester: 'Summer',
          manual_override_expires_at: new Date('2026-12-01T00:00:00.000Z'),
        },
        new Date('2026-11-16T00:00:00.000Z'),
      );
      expect(activeOverride.is_manual_override_active).toBe(true);
      expect(activeOverride.effective_academic_year).toBe('2025-2026');
      expect(activeOverride.effective_semester).toBe('Summer');

      const expiredOverride = resolveActiveAcademicTerm(
        {
          ay_rollover_month: 7,
          manual_academic_year: '2025-2026',
          manual_semester: 'Summer',
          manual_override_expires_at: new Date('2026-10-01T00:00:00.000Z'),
        },
        new Date('2026-11-16T00:00:00.000Z'),
      );
      expect(expiredOverride.is_manual_override_active).toBe(false);
      expect(expiredOverride.is_manual_override_expired).toBe(true);
      expect(expiredOverride.effective_academic_year).toBe('2026-2027');
    });

    it('blocks outdated AY documents when strict mode is ON and allows them when OFF', () => {
      const strictTerm = resolveActiveAcademicTerm(
        { ay_rollover_month: 7, strict_active_term_policy: true },
        new Date(2026, 10, 16),
      );
      expect(
        validateEnrollmentTermAgainstPolicy('2024-2025', '1st Semester', strictTerm),
      ).toEqual(
        objectMatching({
          allowed: false,
        }),
      );
      expect(
        validateEnrollmentTermAgainstPolicy('2026-2027', '1st Semester', strictTerm),
      ).toEqual({ allowed: true });

      const simulationTerm = resolveActiveAcademicTerm(
        { ay_rollover_month: 7, strict_active_term_policy: false },
        new Date(2026, 10, 16),
      );
      expect(
        validateEnrollmentTermAgainstPolicy('2024-2025', '1st Semester', simulationTerm),
      ).toEqual({ allowed: true });
    });

    it('updates academic term settings and emits real-time events', async () => {
      prisma.systemSetting.update.mockResolvedValue({
        ...makeSettings(),
        ay_rollover_month: 8,
        strict_active_term_policy: false,
        manual_academic_year: null,
        manual_semester: null,
        manual_override_expires_at: null,
      });

      const resolved = await service.updateAcademicTermSettings(7, {
        ay_rollover_month: 8,
        strict_active_term_policy: false,
      });

      expect(resolved.ay_rollover_month).toBe(8);
      expect(resolved.strict_active_term_policy).toBe(false);
      expect(events.emitToAll).toHaveBeenCalledWith(
        'settings:academic_term_updated',
        objectMatching({ ay_rollover_month: 8, strict_active_term_policy: false }),
      );
    });
  });

  describe('createSchoolGrading', () => {
    const dto = {
      school_name: 'University of Mindanao',
      grading_scale: 'NUMERIC_4_POINT',
      passing_grade: 2,
      highest_grade: 4,
      failing_grade: 1,
    };

    it('rejects a duplicate school name', async () => {
      await expect(
        service.createSchoolGrading(7, dto as never, 'SCHOLAR'),
      ).rejects.toThrow(
        new ConflictException(
          "School 'University of Mindanao' already exists.",
        ),
      );
    });

    it('marks student-proposed scales as unverified and notifies staff only', async () => {
      prisma.schoolGradingSystem.findFirst.mockResolvedValue(null);
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);

      const created = makeSchoolGrading({ is_verified: false });
      prisma.schoolGradingSystem.create.mockResolvedValue(created);

      const result = await service.createSchoolGrading(
        7,
        { ...dto },
        'SCHOLAR',
      );

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({
          is_verified: false,
          submitted_by_user_id: 7,
          verified_by_employee_id: undefined,
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_GRADING_SUBMITTED_BY_STUDENT',
        'Proposed grading system for school: University of Mindanao',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'school_grading:created',
        created,
      );
      expect(result.is_verified).toBe(false);
    });

    it('marks staff-created scales as verified with the acting employee recorded', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
      const created = makeSchoolGrading({ is_verified: true });
      prisma.schoolGradingSystem.create.mockResolvedValue(created);

      await service.createSchoolGrading(7, { ...dto }, Role.COORDINATOR);

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({
          is_verified: true,
          verified_by_employee_id: 3,
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_GRADING_CREATED',
        'Configured grading system for school: University of Mindanao',
      );
    });

    it('uses plain verification defaults when staff lacks an employee record', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
      prisma.employee.findUnique.mockResolvedValue(null);

      await service.createSchoolGrading(7, { ...dto }, Role.COORDINATOR);

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({
          is_verified: true,
          verified_by_employee_id: undefined,
        }),
      });
    });

    it('honors an explicit is_verified flag from a student proposal', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
      prisma.schoolGradingSystem.create.mockResolvedValue(
        makeSchoolGrading({ is_verified: true }),
      );

      await service.createSchoolGrading(
        7,
        { ...dto, is_verified: true },
        'APPLICANT',
      );

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({ is_verified: true }),
      });
    });

    it('invalidates school and dashboard caches', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);

      await service.createSchoolGrading(7, { ...dto }, Role.COORDINATOR);

      expect(cache.delPattern).toHaveBeenCalledWith('settings:schools:');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:');
    });
  });

  describe('getSchoolGradings', () => {
    it('caches and queries the full list when no verified filter is given', async () => {
      const result = await service.getSchoolGradings();

      expect(cache.wrap).toHaveBeenCalledWith(
        'settings:schools:all',
        anyArg(Function),
        5 * 60 * 1000,
        false,
      );
      expect(prisma.schoolGradingSystem.findMany).toHaveBeenCalledWith(
        objectMatching({ where: undefined }),
      );
      expect(result).toEqual([makeSchoolGrading()]);
    });

    it('filters to verified schools when requested', async () => {
      await service.getSchoolGradings(true, true);

      expect(cache.wrap).toHaveBeenCalledWith(
        'settings:schools:verified',
        anyArg(Function),
        5 * 60 * 1000,
        true,
      );
      expect(prisma.schoolGradingSystem.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { is_verified: true } }),
      );
    });
  });

  describe('verifySchoolGrading', () => {
    it('throws NotFoundException when the school does not exist', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);

      await expect(service.verifySchoolGrading(7, 999)).rejects.toThrow(
        new NotFoundException('School with ID 999 not found.'),
      );
    });

    it('marks the scale verified, records the acting employee, and notifies', async () => {
      prisma.schoolGradingSystem.update.mockResolvedValue(
        makeSchoolGrading({ is_verified: true }),
      );

      const result = await service.verifySchoolGrading(7, 10);

      expect(prisma.schoolGradingSystem.update).toHaveBeenCalledWith({
        where: { school_id: 10 },
        data: { is_verified: true, verified_by_employee_id: 3 },
        include: { verified_by_employee: true },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_GRADING_VERIFIED',
        'Coordinator verified grading scale for school: University of Mindanao',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'school_grading:verified',
        objectMatching({ is_verified: true }),
      );
      expect(events.emitToAll).toHaveBeenCalledWith(
        'school_grading:verified',
        objectMatching({ is_verified: true }),
      );
      expect(result.is_verified).toBe(true);
    });

    it('records the verifier as undefined when the caller has no employee record', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await service.verifySchoolGrading(7, 10);

      expect(prisma.schoolGradingSystem.update).toHaveBeenCalledWith({
        where: { school_id: 10 },
        data: { is_verified: true, verified_by_employee_id: undefined },
        include: { verified_by_employee: true },
      });
    });
  });

  describe('deleteSchoolGrading', () => {
    it('throws NotFoundException when the school grading does not exist', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);

      await expect(service.deleteSchoolGrading(7, 999)).rejects.toThrow(
        new NotFoundException('School with ID 999 not found.'),
      );
    });

    it('deletes the configuration and announces the removal', async () => {
      const result = await service.deleteSchoolGrading(7, 10);

      expect(prisma.schoolGradingSystem.delete).toHaveBeenCalledWith({
        where: { school_id: 10 },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_GRADING_DELETED',
        'Deleted grading system for school: University of Mindanao',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'school_grading:deleted',
        objectMatching({ school_id: 10, schoolId: 10 }),
      );
      expect(result).toEqual({
        message: "School grading system 'University of Mindanao' removed.",
      });
    });
  });

  describe('updateSchoolGrading', () => {
    it('throws NotFoundException for an unknown school id', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);

      await expect(service.updateSchoolGrading(7, 999, {})).rejects.toThrow(
        new NotFoundException(
          'School grading configuration with ID 999 not found.',
        ),
      );
    });

    it('updates the configuration and audits the change', async () => {
      const updated = makeSchoolGrading({ passing_grade: '2.5' });
      prisma.schoolGradingSystem.update.mockResolvedValue(updated);

      const result = await service.updateSchoolGrading(7, 10, {
        passing_grade: 2.5,
      });

      expect(prisma.schoolGradingSystem.update).toHaveBeenCalledWith({
        where: { school_id: 10 },
        data: { passing_grade: 2.5 },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_GRADING_UPDATED',
        'Updated grading system for school: University of Mindanao',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'school_grading:updated',
        updated,
      );
      expect(result).toBe(updated);
    });
  });

  describe('evaluateStudentGrade', () => {
    const schoolUm = {
      grading_scale: 'NUMERIC_4_POINT',
      highest_grade: '4.0',
      passing_grade: '2.0',
      failing_grade: '1.0',
      special_codes: {
        '7.1': 'NOT_FULLY_PAID',
        '7.2': 'LACKING_REQUIREMENTS',
        '9.0': 'DROPPED',
      },
    };
    const schoolPercentage = {
      grading_scale: 'PERCENTAGE_100',
      highest_grade: '100',
      passing_grade: '75',
      failing_grade: '50',
      special_codes: {},
    };

    it('evaluates UM special codes before numeric thresholds', () => {
      expect(service.evaluateStudentGrade('7.1', schoolUm)).toEqual({
        isPassing: false,
        flag: 'PENDING_REQUIREMENTS',
        statusLabel: 'NOT_FULLY_PAID',
      });
      expect(service.evaluateStudentGrade('7.2', schoolUm)).toEqual({
        isPassing: false,
        flag: 'PENDING_REQUIREMENTS',
        statusLabel: 'LACKING_REQUIREMENTS',
      });
      expect(service.evaluateStudentGrade('9.0', schoolUm)).toEqual({
        isPassing: false,
        flag: 'ACADEMIC_FAILURE',
        statusLabel: 'DROPPED',
      });
    });

    it('accepts textual PSD as passing via the special code map', () => {
      expect(
        service.evaluateStudentGrade('PSD', {
          ...schoolPercentage,
          special_codes: { PSD: 'PASSED' },
        }),
      ).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });

    it('treats an unmapped pending-requirement label as pending', () => {
      expect(
        service.evaluateStudentGrade('HOLD', {
          ...schoolPercentage,
          special_codes: { HOLD: 'ON_HOLD' },
        }),
      ).toEqual({
        isPassing: false,
        flag: 'PENDING_REQUIREMENTS',
        statusLabel: 'ON_HOLD',
      });
    });

    it('treats an unmapped failing label as failure', () => {
      expect(
        service.evaluateStudentGrade('9.0', {
          ...schoolPercentage,
          special_codes: { '9.0': 'TOTAL_WITHDRAWAL' },
        }),
      ).toEqual({
        isPassing: false,
        flag: 'ACADEMIC_FAILURE',
        statusLabel: 'TOTAL_WITHDRAWAL',
      });
    });

    it('defaults unknown matched statuses to academic failure', () => {
      expect(
        service.evaluateStudentGrade('X', {
          ...schoolPercentage,
          special_codes: { X: 'MYSTERY_STATUS' },
        }),
      ).toEqual({
        isPassing: false,
        flag: 'ACADEMIC_FAILURE',
        statusLabel: 'MYSTERY_STATUS',
      });
    });

    it('evaluates non-numeric passing marks without a special code map', () => {
      expect(service.evaluateStudentGrade('PSD', {})).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });

    it('evaluates non-numeric failing marks without a special code map', () => {
      expect(service.evaluateStudentGrade('DROPPED', {})).toEqual({
        isPassing: false,
        flag: 'ACADEMIC_FAILURE',
        statusLabel: 'DROPPED',
      });
    });

    it('evaluates non-numeric pending marks without a special code map', () => {
      expect(service.evaluateStudentGrade('INC', {})).toEqual({
        isPassing: false,
        flag: 'PENDING_REQUIREMENTS',
        statusLabel: 'INC',
      });
    });

    it('falls back to a below-passing classification for unknown marks', () => {
      expect(service.evaluateStudentGrade('?', {})).toEqual({
        isPassing: false,
        flag: 'BELOW_PASSING_MARK',
        statusLabel: '?',
      });
    });

    it('passes an ascending 4.0 grade at the passing mark', () => {
      expect(service.evaluateStudentGrade(3.0, schoolUm)).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });

    it('fails an ascending 4.0 grade below the passing mark', () => {
      expect(service.evaluateStudentGrade(1.5, schoolUm)).toEqual({
        isPassing: false,
        flag: 'BELOW_PASSING_MARK',
        statusLabel: 'FAILED',
      });
    });

    it('passes an inverted 5-point grade at or below the passing mark', () => {
      expect(
        service.evaluateStudentGrade(3.0, {
          grading_scale: 'NUMERIC_5_POINT',
          highest_grade: '1.0',
          passing_grade: '3.0',
          failing_grade: '5.0',
          special_codes: {},
        }),
      ).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });

    it('passes a percentage grade at the passing mark', () => {
      expect(service.evaluateStudentGrade(75, schoolPercentage)).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });

    it('falls back to decimal thresholds when no school config is supplied', () => {
      expect(service.evaluateStudentGrade(1.5, null)).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });

    it('falls back to percentage thresholds when no school config is supplied', () => {
      expect(service.evaluateStudentGrade(80, null)).toEqual({
        isPassing: true,
        flag: 'CLEARED',
        statusLabel: 'PASSED',
      });
    });
  });

  describe('evaluateGwaThreshold', () => {
    it('evaluates raw percentage scale', () => {
      expect(service.evaluateGwaThreshold(90, 90)).toBe(true);
      expect(service.evaluateGwaThreshold(89.9, 90)).toBe(false);
    });

    it('evaluates an inverted 5-point scale', () => {
      const cfg = {
        grading_scale: 'NUMERIC_5_POINT',
        highest_grade: '1.0',
        passing_grade: '3.0',
        failing_grade: '5.0',
      };
      expect(service.evaluateGwaThreshold(1.8, 90, cfg)).toBe(true);
      expect(service.evaluateGwaThreshold(1.9, 90, cfg)).toBe(false);
    });

    it('evaluates UM 4.0 scale up to 90% retention', () => {
      const cfg = {
        grading_scale: 'NUMERIC_4_POINT',
        highest_grade: '4.0',
        passing_grade: '2.0',
        failing_grade: '1.0',
      };
      expect(service.evaluateGwaThreshold(3.5, 90, cfg)).toBe(true);
      expect(service.evaluateGwaThreshold(3.49, 90, cfg)).toBe(false);
    });

    it('evaluates UM 4.0 scale above 90% retention', () => {
      const cfg = {
        grading_scale: 'NUMERIC_4_POINT',
        highest_grade: '4.0',
        passing_grade: '2.0',
        failing_grade: '1.0',
      };
      expect(service.evaluateGwaThreshold(3.8, 95, cfg)).toBe(true);
      expect(service.evaluateGwaThreshold(3.7, 95, cfg)).toBe(false);
    });

    it('clamps the normalized threshold between 75 and 100', () => {
      const cfg = {
        grading_scale: 'NUMERIC_5_POINT',
        highest_grade: '1.0',
        passing_grade: '3.0',
        failing_grade: '5.0',
      };
      // A below-75 request is clamped to 75% (cutoff 3.0)
      expect(service.evaluateGwaThreshold(2.0, 50, cfg)).toBe(true);
      expect(service.evaluateGwaThreshold(4.0, 50, cfg)).toBe(false);
      // A above-100 request is clamped to 100% (cutoff 1.0)
      expect(service.evaluateGwaThreshold(1.0, 110, cfg)).toBe(true);
      expect(service.evaluateGwaThreshold(1.5, 110, cfg)).toBe(false);
    });
  });

  describe('getPrograms', () => {
    it('caches and returns the full program list by default (excluding archived)', async () => {
      const result = await service.getPrograms();

      expect(cache.wrap).toHaveBeenCalledWith(
        'settings:programs:all:live',
        anyArg(Function),
        5 * 60 * 1000,
      );
      expect(prisma.academicProgram.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { archived_at: null } }),
      );
      expect(result).toEqual([makeProgram()]);
    });

    it('filters to active programs when requested', async () => {
      await service.getPrograms(true);

      expect(cache.wrap).toHaveBeenCalledWith(
        'settings:programs:active:live',
        anyArg(Function),
        5 * 60 * 1000,
      );
      expect(prisma.academicProgram.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { is_active: true, archived_at: null } }),
      );
    });
  });

  describe('createProgram', () => {
    const dto = {
      program_code: ' BSIT ',
      program_name: ' BS Information Technology ',
      category: 'College',
      description: 'Track IT',
      is_active: true,
    };

    it('normalizes the code and name before persisting', async () => {
      await service.createProgram(7, dto);

      expect(prisma.academicProgram.create).toHaveBeenCalledWith({
        data: {
          program_code: 'BSIT',
          program_name: 'BS Information Technology',
          category: 'College',
          description: 'Track IT',
          is_active: true,
        },
      });
    });

    it('rejects a duplicate program code', async () => {
      prisma.academicProgram.findFirst.mockResolvedValue(
        makeProgram({ program_code: 'BSIT', program_name: 'Other Name' }),
      );

      await expect(service.createProgram(7, dto as never)).rejects.toThrow(
        new ConflictException("Program code 'BSIT' is already registered."),
      );
    });

    it('rejects a duplicate program name', async () => {
      prisma.academicProgram.findFirst.mockResolvedValue(
        makeProgram({
          program_code: 'OTHER',
          program_name: 'BS Information Technology',
        }),
      );

      await expect(service.createProgram(7, dto as never)).rejects.toThrow(
        new ConflictException(
          "Program name 'BS Information Technology' is already registered.",
        ),
      );
    });

    it('defaults the category to College when omitted', async () => {
      await service.createProgram(7, {
        ...dto,
        category: undefined,
      });

      expect(prisma.academicProgram.create).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ category: 'College' }),
        }),
      );
    });

    it('defaults is_active to true when omitted', async () => {
      await service.createProgram(7, {
        ...dto,
        is_active: undefined,
      });

      expect(prisma.academicProgram.create).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ is_active: true }),
        }),
      );
    });

    it('audits, invalidates program cache, and emits creation event', async () => {
      await service.createProgram(7, dto);

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'PROGRAM_CREATED',
        "Registered new academic program 'BS Information Technology' (BSIT)",
      );
      expect(cache.delPattern).toHaveBeenCalledWith('settings:programs:');
      expect(events.emitToAll).toHaveBeenCalledWith(
        'program:created',
        makeProgram(),
      );
    });
  });

  describe('updateProgram', () => {
    it('throws NotFoundException when the program does not exist', async () => {
      prisma.academicProgram.findUnique.mockResolvedValueOnce(null);

      await expect(service.updateProgram(7, 999, {})).rejects.toThrow(
        new NotFoundException('Academic program with ID 999 not found.'),
      );
    });

    it('rejects a duplicate program code', async () => {
      prisma.academicProgram.findUnique
        .mockResolvedValueOnce(makeProgram())
        .mockResolvedValueOnce(
          makeProgram({ program_id: 2, program_code: 'BSCS' }),
        );

      await expect(
        service.updateProgram(7, 1, { program_code: 'BSCS' }),
      ).rejects.toThrow(
        new ConflictException("Program code 'BSCS' is already taken."),
      );
    });

    it('rejects a duplicate program name', async () => {
      prisma.academicProgram.findUnique
        .mockResolvedValueOnce(makeProgram())
        .mockResolvedValueOnce(
          makeProgram({ program_id: 2, program_name: 'BSCS Name' }),
        );

      await expect(
        service.updateProgram(7, 1, {
          program_name: 'BSCS Name',
        }),
      ).rejects.toThrow(
        new ConflictException("Program name 'BSCS Name' is already taken."),
      );
    });

    it('performs a partial update with only provided fields', async () => {
      const updated = makeProgram({ category: 'Vocational' });
      prisma.academicProgram.update.mockResolvedValue(updated);

      const result = await service.updateProgram(7, 1, {
        category: ' Vocational ',
      });

      expect(prisma.academicProgram.update).toHaveBeenCalledWith({
        where: { program_id: 1 },
        data: { category: 'Vocational' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'PROGRAM_UPDATED',
        "Updated academic program 'BS Information Technology' (BSIT)",
      );
      expect(events.emitToAll).toHaveBeenCalledWith('program:updated', updated);
      expect(result).toBe(updated);
    });
  });

  describe('deleteProgram', () => {
    it('throws NotFoundException when the program does not exist', async () => {
      prisma.academicProgram.findUnique.mockResolvedValue(null);

      await expect(service.deleteProgram(7, 999)).rejects.toThrow(
        new NotFoundException('Academic program with ID 999 not found.'),
      );
    });

    it('archives the program, audits, invalidates cache, and emits event', async () => {
      prisma.academicProgram.update.mockResolvedValue(
        makeProgram({ archived_at: new Date('2026-11-09T00:00:00.000Z'), is_active: false }),
      );

      const result = await service.deleteProgram(7, 1);

      expect(prisma.academicProgram.update).toHaveBeenCalledWith({
        where: { program_id: 1 },
        data: objectMatching({
          archive_reason: 'PROGRAM_REMOVED',
          is_active: false,
          archived_by_user_id: 7,
        }),
      });
      expect(prisma.academicProgram.delete).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'PROGRAM_ARCHIVED',
        "Archived academic program 'BS Information Technology' (BSIT)",
      );
      expect(cache.delPattern).toHaveBeenCalledWith('settings:programs:');
      expect(events.emitToAll).toHaveBeenCalledWith('program:deleted', {
        program_id: 1,
      });
      expect(result).toEqual(
        objectMatching({
          message:
            "Program 'BS Information Technology' archived successfully.",
        }),
      );
    });
  });

  describe('getSchools', () => {
    it('returns the cached list when present', async () => {
      const cached = [makeSchool()];
      cache.get.mockResolvedValue(cached);

      const result = await service.getSchools();

      expect(prisma.school.findMany).not.toHaveBeenCalled();
      expect(result).toBe(cached);
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('queries and caches schools when not cached (excluding archived)', async () => {
      cache.get.mockResolvedValue(undefined);
      const result = await service.getSchools();

      expect(prisma.school.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { archived_at: null } }),
      );
      expect(cache.set).toHaveBeenCalledWith(
        'settings:schools_list:all:live',
        [makeSchool()],
        300,
      );
      expect(result).toEqual([makeSchool()]);
    });

    it('filters to active schools and uses the active key', async () => {
      cache.get.mockResolvedValue(undefined);

      await service.getSchools(true);

      expect(cache.get).toHaveBeenCalledWith('settings:schools_list:active:live');
      expect(prisma.school.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { is_active: true, archived_at: null } }),
      );
    });
  });

  describe('createSchool', () => {
    const dto = {
      school_name: ' University of Mindanao ',
      school_code: ' um ',
      address: ' Davao City ',
      contact_email: ' um@um.edu.ph ',
      contact_number: ' 0917 ',
      grading_scale: 'NUMERIC_4_POINT' as const,
    };

    it('normalizes inputs before checking duplicates and creating', async () => {
      await service.createSchool(7, dto);

      expect(prisma.school.create).toHaveBeenCalledWith({
        data: objectMatching({
          school_name: 'University of Mindanao',
          school_code: 'UM',
          address: 'Davao City',
        }),
        include: { grading_system: true },
      });
    });

    it('throws ConflictException for a duplicate school name', async () => {
      prisma.school.findUnique.mockResolvedValueOnce(makeSchool());

      await expect(service.createSchool(7, dto as never)).rejects.toThrow(
        new ConflictException(
          "School with name 'University of Mindanao' already exists.",
        ),
      );
    });

    it('throws ConflictException for a duplicate school code', async () => {
      prisma.school.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSchool({ school_code: 'UM' }));

      await expect(service.createSchool(7, dto as never)).rejects.toThrow(
        new ConflictException(
          "School code 'UM' is already in use by 'University of Mindanao'.",
        ),
      );
    });

    it('skips the grading system lookup entirely for a NONE scale', async () => {
      const findUnique = prisma.schoolGradingSystem.findUnique;

      await service.createSchool(7, {
        ...dto,
        grading_scale: 'NONE',
      });

      expect(findUnique).not.toHaveBeenCalled();
      expect(prisma.schoolGradingSystem.create).not.toHaveBeenCalled();
      expect(prisma.school.create).toHaveBeenCalledWith({
        data: objectMatching({ grading_system_id: null }),
        include: { grading_system: true },
      });
    });

    it('returns the explicitly requested grading id when no scale changes are needed', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(
        makeSchoolGrading({ school_id: 10 }),
      );

      await service.createSchool(7, {
        ...dto,
        grading_scale: undefined,
        grading_system_id: 10,
      });

      expect(prisma.schoolGradingSystem.create).not.toHaveBeenCalled();
      expect(prisma.school.create).toHaveBeenCalledWith({
        data: objectMatching({ grading_system_id: 10 }),
        include: { grading_system: true },
      });
    });

    it('creates a default 100-point grading system when one does not exist', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
      prisma.schoolGradingSystem.create.mockResolvedValue(makeSchoolGrading());

      await service.createSchool(7, {
        ...dto,
        grading_scale: 'PERCENTAGE_100',
      });

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({
          grading_scale: 'PERCENTAGE_100',
          highest_grade: 100,
          passing_grade: 75,
          failing_grade: 50,
          min_grade: 50,
          max_grade: 100,
        }),
      });
    });

    it('creates a new default 4-point grading system when none exists', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
      prisma.schoolGradingSystem.create.mockResolvedValue(makeSchoolGrading());

      await service.createSchool(7, dto);

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({
          grading_scale: 'NUMERIC_4_POINT',
          highest_grade: 4,
          passing_grade: 2,
          failing_grade: 1,
        }),
      });
    });

    it('audits, invalidates cache, and emits creation event', async () => {
      await service.createSchool(7, dto);

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_CREATED',
        "Registered new academic institution 'University of Mindanao' (UM)",
      );
      expect(cache.delPattern).toHaveBeenCalledWith('settings:schools_list:');
      expect(events.emitToAll).toHaveBeenCalledWith(
        'school:created',
        makeSchool(),
      );
    });
  });

  describe('updateSchool', () => {
    it('throws NotFoundException when the school does not exist', async () => {
      prisma.school.findUnique.mockResolvedValue(null);

      await expect(service.updateSchool(7, 999, {})).rejects.toThrow(
        new NotFoundException('School with ID 999 not found.'),
      );
    });

    it('rejects a duplicate school name', async () => {
      prisma.school.findUnique
        .mockResolvedValueOnce(makeSchool())
        .mockResolvedValueOnce(makeSchool({ school_id: 7 }));

      await expect(
        service.updateSchool(7, 5, {
          school_name: 'Ateneo de Davao',
        }),
      ).rejects.toThrow(
        new ConflictException(
          "School name 'Ateneo de Davao' is already taken.",
        ),
      );
    });

    it('rejects a duplicate school code', async () => {
      prisma.school.findUnique
        .mockResolvedValueOnce(makeSchool())
        .mockResolvedValueOnce(
          makeSchool({ school_id: 7, school_code: 'HOST' }),
        );

      await expect(
        service.updateSchool(7, 5, { school_code: 'host' }),
      ).rejects.toThrow(
        new ConflictException("School code 'HOST' is already taken."),
      );
    });

    it('updates only the provided fields', async () => {
      prisma.school.findUnique.mockResolvedValueOnce(makeSchool());
      const updated = makeSchool({ school_name: 'Ateneo de Davao' });
      prisma.school.update.mockResolvedValue(updated);

      const result = await service.updateSchool(7, 5, {
        school_name: ' Ateneo de Davao ',
      });

      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { school_id: 5 },
        data: { school_name: 'Ateneo de Davao' },
        include: { grading_system: true },
      });
      expect(result).toBe(updated);
    });

    it('resolves the grading system when one of the grading fields is provided', async () => {
      prisma.school.findUnique.mockResolvedValueOnce(makeSchool());
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
      prisma.schoolGradingSystem.create.mockResolvedValue(
        makeSchoolGrading({ school_id: 10 }),
      );

      await service.updateSchool(7, 5, {
        grading_scale: 'PERCENTAGE_100',
      });

      expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
        data: objectMatching({
          grading_scale: 'PERCENTAGE_100',
          highest_grade: 100,
        }),
      });
      expect(prisma.school.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ grading_system_id: 10 }),
        }),
      );
    });
  });

  describe('deleteSchool', () => {
    it('throws NotFoundException when the school does not exist', async () => {
      prisma.school.findUnique.mockResolvedValue(null);

      await expect(service.deleteSchool(7, 999)).rejects.toThrow(
        new NotFoundException('School with ID 999 not found.'),
      );
    });

    it('archives schools that still have scholars attached', async () => {
      prisma.school.findUnique.mockResolvedValue(
        makeSchool({ scholar_profiles: [{ profile_id: 11 }] }),
      );
      prisma.school.update.mockResolvedValue(
        makeSchool({ is_active: false, archived_at: new Date(), archive_reason: 'SCHOOL_CLOSED' }),
      );

      const result = await service.deleteSchool(7, 5);

      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { school_id: 5 },
        data: objectMatching({
          archive_reason: 'SCHOOL_CLOSED',
          is_active: false,
          archived_by_user_id: 7,
        }),
        include: { grading_system: true },
      });
      expect(prisma.school.delete).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_ARCHIVED',
        expect.any(String),
      );
      expect(result.message).toContain('archived');
    });

    it('archives schools without scholars instead of deleting them', async () => {
      prisma.school.findUnique.mockResolvedValue(
        makeSchool({ scholar_profiles: [] }),
      );
      prisma.school.update.mockResolvedValue(
        makeSchool({ is_active: false, archived_at: new Date(), archive_reason: 'SCHOOL_CLOSED' }),
      );

      const result = await service.deleteSchool(7, 5);

      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { school_id: 5 },
        data: objectMatching({
          archive_reason: 'SCHOOL_CLOSED',
          is_active: false,
          archived_by_user_id: 7,
        }),
        include: { grading_system: true },
      });
      expect(prisma.school.delete).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SCHOOL_ARCHIVED',
        expect.any(String),
      );
      expect(events.emitToAll).toHaveBeenCalledWith('school:deleted', {
        school_id: 5,
      });
      expect(result.message).toContain('archived');
    });
  });
});
