import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MeetingsService } from './meetings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { QueryMeetingsDto } from './dto/query-meetings.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  meeting: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  scholarProfile: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
});

const makeMeeting = (overrides: Record<string, unknown> = {}) => ({
  meeting_id: 12,
  application_id: 42,
  scholar_profile_id: 11,
  application: {
    application_id: 42,
    status: 'UNDER_REVIEW',
    stage: 'Under review',
    scholar_profile_id: 11,
  },
  scholar_profile: {
    profile_id: 11,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    course_of_study: 'BSIT',
    scholarship_track: 'Academic Track',
  },
  employee: {
    employee_id: 2,
    first_name: 'Maria',
    last_name: 'Santos',
    title: 'Coordinator',
    user: { role: 'COORDINATOR' },
  },
  ...overrides,
});

const query = (
  overrides: Partial<QueryMeetingsDto> = {},
): QueryMeetingsDto => ({ ...overrides });

describe('MeetingsService', () => {
  let service: MeetingsService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();

    prisma.meeting.findUnique.mockResolvedValue(makeMeeting());
    prisma.meeting.findMany.mockResolvedValue([makeMeeting()]);
    prisma.meeting.count.mockResolvedValue(1);
    prisma.scholarProfile.findUnique.mockResolvedValue({ profile_id: 11 });
    prisma.$transaction.mockImplementation(
      async (promises: Promise<unknown>[]) => Promise.all(promises),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeetingsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<MeetingsService>(MeetingsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('returns all matching meetings for staff callers', async () => {
      const result = await service.findAll(query(), {
        user_id: 2,
        role: Role.COORDINATOR,
      });

      expect(prisma.meeting.count).toHaveBeenCalledWith({ where: {} });
      expect(prisma.meeting.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: {},
          orderBy: { scheduled_at: 'asc' },
          skip: 0,
          take: 50,
        }),
      );
      expect(result).toEqual({
        data: [makeMeeting()],
        total: 1,
        page: 1,
        limit: 50,
      });
    });

    it('filters by status when provided', async () => {
      await service.findAll(query({ status: 'SCHEDULED' }), {
        user_id: 2,
        role: Role.ADMIN,
      });

      expect(prisma.meeting.count).toHaveBeenCalledWith({
        where: { AND: [{ status: 'SCHEDULED' }] },
      });
    });

    it('filters by applicationId when provided', async () => {
      await service.findAll(query({ applicationId: 42 }), {
        user_id: 2,
        role: Role.ADMIN,
      });

      expect(prisma.meeting.count).toHaveBeenCalledWith({
        where: { AND: [{ application_id: 42 }] },
      });
    });

    it('restricts scholar-side callers to their own meetings', async () => {
      const result = await service.findAll(query(), {
        user_id: 7,
        role: Role.SCHOLAR,
      });

      expect(prisma.meeting.count).toHaveBeenCalledWith({
        where: {
          AND: [
            {
              OR: [
                { scholar_profile_id: 11 },
                { application: { scholar_profile_id: 11 } },
              ],
            },
          ],
        },
      });
      expect(result.total).toBe(1);
    });

    it('returns an empty result when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      const result = await service.findAll(query(), {
        user_id: 7,
        role: Role.SCHOLAR,
      });

      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 50 });
      expect(prisma.meeting.count).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an invalid from date', async () => {
      await expect(
        service.findAll(query({ from: 'not-a-date' }), {
          user_id: 2,
          role: Role.COORDINATOR,
        }),
      ).rejects.toThrow(new BadRequestException('Invalid from date provided.'));
    });

    it('throws BadRequestException for an invalid to date', async () => {
      await expect(
        service.findAll(query({ to: 'not-a-date' }), {
          user_id: 2,
          role: Role.COORDINATOR,
        }),
      ).rejects.toThrow(new BadRequestException('Invalid to date provided.'));
    });

    it('builds a scheduled_at range when both from and to are valid', async () => {
      await service.findAll(
        query({
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-10-01T00:00:00.000Z',
        }),
        { user_id: 2, role: Role.COORDINATOR },
      );

      expect(prisma.meeting.count).toHaveBeenCalledWith({
        where: {
          AND: [
            {
              scheduled_at: {
                gte: new Date('2026-09-01T00:00:00.000Z'),
                lte: new Date('2026-10-01T00:00:00.000Z'),
              },
            },
          ],
        },
      });
    });

    it('caps the limit to 200 and paginates with the requested page', async () => {
      const result = await service.findAll(query({ page: 3, limit: 500 }), {
        user_id: 2,
        role: Role.COORDINATOR,
      });

      expect(prisma.meeting.findMany).toHaveBeenCalledWith(
        objectMatching({ skip: 400, take: 200 }),
      );
      expect(result.limit).toBe(200);
      expect(result.page).toBe(3);
    });
  });

  describe('findOne', () => {
    it('returns the meeting for a staff caller', async () => {
      const result = await service.findOne(12, {
        user_id: 2,
        role: Role.ADMIN,
      });

      expect(result).toEqual(makeMeeting());
    });

    it('throws NotFoundException when the meeting is missing', async () => {
      prisma.meeting.findUnique.mockResolvedValue(null);

      await expect(
        service.findOne(999, { user_id: 2, role: Role.COORDINATOR }),
      ).rejects.toThrow(new NotFoundException('Meeting ID 999 not found.'));
    });

    it('allows a scholar to view their own meeting by profile ownership', async () => {
      const result = await service.findOne(12, {
        user_id: 7,
        role: Role.SCHOLAR,
      });

      expect(result).toEqual(makeMeeting());
    });

    it('allows a scholar to view a meeting linked through their application', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue({ profile_id: 99 });
      prisma.meeting.findUnique.mockResolvedValue(
        makeMeeting({
          scholar_profile_id: null,
          application: {
            application_id: 42,
            status: 'UNDER_REVIEW',
            stage: 'Under review',
            scholar_profile_id: 99,
          },
        }),
      );

      const result = await service.findOne(12, {
        user_id: 7,
        role: Role.SCHOLAR,
      });

      expect(result.meeting_id).toBe(12);
    });

    it('throws ForbiddenException when the scholar does not own the meeting', async () => {
      prisma.meeting.findUnique.mockResolvedValue(
        makeMeeting({
          scholar_profile_id: 99,
          application: {
            application_id: 42,
            status: 'UNDER_REVIEW',
            stage: 'Under review',
            scholar_profile_id: 99,
          },
        }),
      );

      await expect(
        service.findOne(12, { user_id: 7, role: Role.SCHOLAR }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to view this meeting.',
        ),
      );
    });

    it('throws ForbiddenException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.findOne(12, { user_id: 7, role: Role.SCHOLAR }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to view this meeting.',
        ),
      );
    });
  });
});
