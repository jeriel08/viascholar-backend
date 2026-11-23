import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from './archive.service.js';

const createPrismaMock = () => ({
  scholarProfile: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  school: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  academicProgram: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
});

const createAuditMock = () => ({
  log: vi.fn(),
});

const createEventsMock = () => ({
  emitToAll: vi.fn(),
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});

const createCacheMock = () => ({
  delPattern: vi.fn(),
});

describe('ArchiveService', () => {
  let service: ArchiveService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new ArchiveService(
      prisma as any,
      createAuditMock() as any,
      createEventsMock() as any,
      createCacheMock() as any,
    );
  });

  describe('listArchived', () => {
    it('excludes GRADUATED scholars when listing archived scholars', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        {
          profile_id: 10,
          archive_reason: 'FAILED_SECOND_CHANCE',
          first_name: 'Rodelyn',
          last_name: 'Pingca',
        },
      ]);
      prisma.scholarProfile.count.mockResolvedValue(1);

      const res = await service.listArchived({ entity: 'scholar' });

      expect(prisma.scholarProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            archived_at: { not: null },
            user: { role: 'SCHOLAR' },
            AND: [
              {
                OR: [
                  { archive_reason: null },
                  { archive_reason: { not: 'GRADUATED' } },
                ],
              },
            ],
          }),
        }),
      );
      expect(res.total).toBe(1);
      expect(res.data).toHaveLength(1);
    });

    it('returns an empty result when entity=scholar filters specifically for GRADUATED', async () => {
      const res = await service.listArchived({
        entity: 'scholar',
        reason: 'GRADUATED',
      });

      expect(prisma.scholarProfile.findMany).not.toHaveBeenCalled();
      expect(res).toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });
    });

    it('lists GRADUATED scholars with year filter, search, and alumni summary stats', async () => {
      const gradDate2024 = new Date('2024-04-30T09:00:00.000Z');
      const gradDate2022 = new Date('2022-06-30T09:00:00.000Z');

      prisma.scholarProfile.findMany
        .mockResolvedValueOnce([
          {
            profile_id: 7,
            user_id: 17,
            first_name: 'Gladys',
            last_name: 'Cartin',
            student_number: 'LBSP-2020-008',
            course_of_study: 'Bachelor of Elementary Education',
            scholarship_track: 'Academic Track',
            school_name: 'Holy Cross College of Calinan, Inc.',
            archived_at: gradDate2024,
            archive_reason: 'GRADUATED',
            archive_notes: 'Graduated April 2024.',
            academic_baseline_status: 'BASELINE_FROZEN',
            user: {
              user_id: 17,
              email: 'gladys.cartin@viascholar.demo',
              role: 'SCHOLAR',
              is_active: false,
            },
            school: {
              school_id: 8,
              school_name: 'Holy Cross College of Calinan, Inc.',
              school_code: 'HCCC',
            },
            school_grading_system: {
              school_id: 8,
              school_name: 'Holy Cross College of Calinan, Inc.',
              grading_scale: 'PERCENTAGE_100',
            },
            disbursements: [
              { amount: '21302.01', academic_year: '2020-2021' },
              { amount: '17586.22', academic_year: '2023-2024' },
            ],
            enrollments: [
              { academic_year: '2020-2021', semester: '1st Semester' },
              { academic_year: '2023-2024', semester: '2nd Semester' },
            ],
            grade_reports: [
              {
                gpa: '91.00',
                academic_year: '2023-2024',
                semester: '2nd Semester',
              },
            ],
          },
        ])
        .mockResolvedValueOnce([
          {
            archived_at: gradDate2024,
            school_name: 'Holy Cross College of Calinan, Inc.',
            school: { school_name: 'Holy Cross College of Calinan, Inc.' },
            disbursements: [{ amount: '21302.01' }, { amount: '17586.22' }],
          },
          {
            archived_at: gradDate2022,
            school_name: 'San Pedro College',
            school: { school_name: 'San Pedro College' },
            disbursements: [{ amount: '31840.15' }],
          },
        ]);
      prisma.scholarProfile.count.mockResolvedValue(1);

      const res = (await service.listArchived({
        entity: 'graduate',
        year: '2024',
        search: 'gladys',
        page: 1,
        limit: 12,
      })) as any;

      expect(prisma.scholarProfile.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            archive_reason: 'GRADUATED',
            user: { role: 'SCHOLAR' },
            archived_at: {
              gte: new Date('2024-01-01T00:00:00.000Z'),
              lt: new Date('2025-01-01T00:00:00.000Z'),
            },
            OR: expect.any(Array),
          }),
        }),
      );

      expect(res.total).toBe(1);
      expect(res.data[0]).toMatchObject({
        profile_id: 7,
        graduation_year: 2024,
        total_disbursed: 38888.23,
        terms_completed: 2,
        latest_gpa: 91,
        active_years_span: '2020-2024',
      });
      expect(res.availableYears).toEqual(['2024', '2022']);
      expect(res.summary).toEqual({
        totalGraduates: 2,
        totalSupportAmount: 70728.38,
        uniqueSchoolsCount: 2,
        latestGraduationYear: 2024,
      });
    });
  });

  describe('getArchiveSummary', () => {
    it('separates non-graduated archived scholars from graduated count', async () => {
      prisma.scholarProfile.count
        .mockResolvedValueOnce(2) // non-graduated archived scholars
        .mockResolvedValueOnce(1) // archived applicants
        .mockResolvedValueOnce(8) // graduated
        .mockResolvedValueOnce(1) // failed second chance
        .mockResolvedValueOnce(1) // withdrawn
        .mockResolvedValueOnce(0) // terminated
        .mockResolvedValueOnce(1); // rejected applicants
      prisma.school.count.mockResolvedValue(0);
      prisma.academicProgram.count.mockResolvedValue(0);

      const summary = await service.getArchiveSummary();

      expect(prisma.scholarProfile.count).toHaveBeenNthCalledWith(1, {
        where: {
          archived_at: { not: null },
          user: { role: 'SCHOLAR' },
          OR: [{ archive_reason: null }, { archive_reason: { not: 'GRADUATED' } }],
        },
      });
      expect(summary.totals).toEqual({
        scholars: 2,
        graduates: 8,
        applicants: 1,
        schools: 0,
        programs: 0,
        all: 3,
      });
    });
  });
});
