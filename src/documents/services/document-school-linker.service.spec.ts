import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentSchoolLinkerService } from './document-school-linker.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsGateway } from '../../events/events.gateway.js';

const createPrismaMock = () => ({
  schoolGradingSystem: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  scholarProfile: {
    update: vi.fn(),
  },
});

const createEventsMock = () => ({
  emitToStaff: vi.fn(),
});

const makeSchool = (overrides: Record<string, unknown> = {}) => ({
  school_id: 3,
  school_name: 'University of Mindanao',
  grading_scale: 'NUMERIC_4_POINT',
  is_verified: true,
  ...overrides,
});

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

describe('DocumentSchoolLinkerService', () => {
  let service: DocumentSchoolLinkerService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let events: ReturnType<typeof createEventsMock>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    events = createEventsMock();

    prisma.schoolGradingSystem.findFirst.mockResolvedValue(null);
    prisma.schoolGradingSystem.findMany.mockResolvedValue([makeSchool()]);
    prisma.schoolGradingSystem.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          school_id: 99,
          ...data,
        }),
    );
    prisma.scholarProfile.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentSchoolLinkerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get<DocumentSchoolLinkerService>(
      DocumentSchoolLinkerService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('no-ops on an empty school name', async () => {
    await service.linkSchoolGradingSystem(11, 7, '   ');

    expect(prisma.schoolGradingSystem.findFirst).not.toHaveBeenCalled();
    expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
  });

  it('links the school when the direct match succeeds', async () => {
    prisma.schoolGradingSystem.findFirst.mockResolvedValue(makeSchool());

    await service.linkSchoolGradingSystem(
      11,
      7,
      'University of Mindanao',
      null,
      null,
    );

    expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
      where: { profile_id: 11 },
      data: { school_id: 3, school_name: 'University of Mindanao' },
    });
    expect(prisma.scholarProfile.update.mock.calls[0][0]).toEqual(
      objectMatching({
        data: objectMatching({
          school_name: 'University of Mindanao',
        }),
      }),
    );
  });

  it('links a fuzzy-normalized school when no exact match exists', async () => {
    // findFirst returns null (no exact match), findMany has the UM record.
    await service.linkSchoolGradingSystem(
      11,
      7,
      'University of Mindanao (UM)',
      null,
      null,
    );

    expect(prisma.scholarProfile.update).toHaveBeenCalledWith(
      objectMatching({
        data: objectMatching({ school_id: 3 }),
      }),
    );
  });

  it('falls back to a DepEd-verified high school match for high school documents', async () => {
    prisma.schoolGradingSystem.findMany.mockResolvedValue([
      makeSchool({
        school_id: 5,
        school_name: 'Deped DepEd Region XII',
        is_verified: true,
      }),
    ]);

    await service.linkSchoolGradingSystem(
      11,
      7,
      'Some City High School',
      null,
      null,
    );

    expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
  });

  it('does not link a high school match when it is not a straight percentage scale', async () => {
    prisma.schoolGradingSystem.findMany.mockResolvedValue([
      makeSchool({
        school_id: 6,
        school_name: 'Davao City High School',
        grading_scale: 'NUMERIC_5_POINT',
        is_verified: true,
      }),
    ]);

    await service.linkSchoolGradingSystem(
      11,
      7,
      'Davao City High School',
      {
        highest_grade: 100,
        passing_grade: 75,
        failing_grade: 60,
        grading_scale: 'PERCENTAGE_100',
      },
      null,
    );

    // A matched HS school intentionally doesn't get linked (its scale is the
    // standard deped one): schoolIdToLink is undefined.
    expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
  });

  it('creates a new unverified school when a college school with a grading legend is detected', async () => {
    prisma.schoolGradingSystem.findMany.mockResolvedValue([]);

    await service.linkSchoolGradingSystem(
      11,
      7,
      'Fictional Coastal College',
      {
        highest_grade: 4.0,
        passing_grade: 2.0,
        failing_grade: 1.0,
        grading_scale: 'NUMERIC_4_POINT',
        special_codes: { PSD: 'PASSED' },
        notes: '4.0 scale',
        legend_title: 'UM Grading Scale',
      },
      null,
    );

    expect(prisma.schoolGradingSystem.create).toHaveBeenCalledWith({
      data: objectMatching({
        school_name: 'Fictional Coastal College',
        grading_scale: 'NUMERIC_4_POINT',
        highest_grade: 4.0,
        is_verified: false,
        submitted_by_user_id: 7,
      }),
    });
    expect(events.emitToStaff).toHaveBeenCalledWith(
      'school_grading:created',
      objectMatching({ school_id: 99 }),
    );
    expect(prisma.scholarProfile.update).toHaveBeenCalledWith(
      objectMatching({
        data: objectMatching({ school_id: 99 }),
      }),
    );
  });

  it('does not create a new school for high school documents even with a legend', async () => {
    prisma.schoolGradingSystem.findMany.mockResolvedValue([]);

    await service.linkSchoolGradingSystem(
      11,
      7,
      'Some City High School',
      {
        highest_grade: 100,
        passing_grade: 75,
        failing_grade: 60,
        grading_scale: 'PERCENTAGE_100',
      },
      null,
    );

    expect(prisma.schoolGradingSystem.create).not.toHaveBeenCalled();
  });

  it('keeps the current school name when one is already recorded', async () => {
    prisma.schoolGradingSystem.findFirst.mockResolvedValue(makeSchool());

    await service.linkSchoolGradingSystem(
      11,
      7,
      'University of Mindanao',
      null,
      'University of Mindanao',
    );

    const call = prisma.scholarProfile.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.school_id).toBe(3);
    expect(call.data.school_name).toBeUndefined();
  });

  it('swallows errors from the linkage and just logs a warning', async () => {
    prisma.schoolGradingSystem.findFirst.mockRejectedValue(
      new Error('db exploded'),
    );

    await service.linkSchoolGradingSystem(
      11,
      7,
      'University of Mindanao',
      null,
      null,
    );

    expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
  });
});
