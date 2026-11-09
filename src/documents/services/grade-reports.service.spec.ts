import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GradeReportsService } from './grade-reports.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import type { UpdateGradeReportStatusDto } from '../dto/update-grade-report-status.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
  },
  employee: {
    findUnique: vi.fn(),
  },
  gradeReport: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({ sendGradeReportStatusUpdated: vi.fn() });

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  report_id: 71,
  scholar_profile_id: 11,
  document_id: 55,
  academic_year: '2026-2027',
  semester: '1st Semester',
  gpa: 1.5,
  status: 'PENDING',
  is_eligible: false,
  remarks: 'Prior remark',
  scholar_profile: {
    profile_id: 11,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    user: { user_id: 7, email: 'juan@example.com' },
  },
  ...overrides,
});

describe('GradeReportsService', () => {
  let service: GradeReportsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();

    prisma.scholarProfile.findUnique.mockResolvedValue({ profile_id: 11 });
    prisma.employee.findUnique.mockResolvedValue({
      employee_id: 201,
      first_name: 'Cora',
      last_name: 'Coordinator',
    });
    prisma.gradeReport.findMany.mockResolvedValue([makeReport()]);
    prisma.gradeReport.findUnique.mockResolvedValue(makeReport());
    prisma.gradeReport.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeReport({ ...data })),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GradeReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
      ],
    }).compile();

    service = module.get<GradeReportsService>(GradeReportsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getMyGradeReports', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getMyGradeReports(7)).rejects.toThrow(
        new NotFoundException('Scholar profile not found.'),
      );
    });

    it("queries the scholar profile's reports newest first", async () => {
      const reports = await service.getMyGradeReports(7);

      expect(prisma.gradeReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scholar_profile_id: 11 },
          orderBy: { submitted_at: 'desc' },
        }),
      );
      expect(reports).toHaveLength(1);
    });
  });

  describe('getAllGradeReports', () => {
    it('returns every report with no filters', async () => {
      await service.getAllGradeReports({});

      const call = prisma.gradeReport.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({});
    });

    it('applies status, school year, and semester filters', async () => {
      await service.getAllGradeReports({
        status: 'FLAGGED',
        academic_year: '2026-2027',
        semester: '2nd Semester',
      });

      const call = prisma.gradeReport.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.status).toBe('FLAGGED');
      expect(call.where.academic_year).toBe('2026-2027');
      expect(call.where.semester).toBe('2nd Semester');
    });

    it('exercises a case-insensitive search across names and student number', async () => {
      await service.getAllGradeReports({
        search: 'Juan',
      });

      expect(prisma.gradeReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: objectMatching({
            scholar_profile: {
              is: {
                OR: [
                  { first_name: { contains: 'Juan', mode: 'insensitive' } },
                  { last_name: { contains: 'Juan', mode: 'insensitive' } },
                  { student_number: { contains: 'Juan', mode: 'insensitive' } },
                ],
              },
            },
          }),
        }),
      );
    });
  });

  describe('updateGradeReportStatus', () => {
    const dto = {
      status: 'APPROVED',
      remarks: 'All good',
    } as UpdateGradeReportStatusDto;

    it('throws NotFoundException when the coordinator has no employee profile', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.updateGradeReportStatus(7, 71, dto)).rejects.toThrow(
        new NotFoundException('Employee profile not found for current user.'),
      );
    });

    it('throws NotFoundException when the report does not exist', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(null);

      await expect(
        service.updateGradeReportStatus(7, 999, dto),
      ).rejects.toThrow(
        new NotFoundException('Grade report ID 999 not found.'),
      );
    });

    it('marks the report APPROVED eligible and audits the override', async () => {
      const updated = await service.updateGradeReportStatus(7, 71, dto);

      expect(prisma.gradeReport.update).toHaveBeenCalledWith(
        objectMatching({
          where: { report_id: 71 },
          data: objectMatching({
            status: 'APPROVED',
            is_eligible: true,
            remarks: 'All good',
            reviewed_by_employee_id: 201,
            reviewed_at: anyArg(Date),
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'GRADE_REPORT_STATUS_UPDATED',
        expect.stringContaining('APPROVED'),
      );
      expect(mail.sendGradeReportStatusUpdated).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({
          studentName: 'Juan Dela Cruz',
          status: 'APPROVED',
          remarks: 'All good',
        }),
      );
      expect(updated.status).toBe('APPROVED');
    });

    it('marks the report FLAGGED ineligible and preserves previous remarks', async () => {
      await service.updateGradeReportStatus(7, 71, {
        status: 'FLAGGED',
      });

      expect(prisma.gradeReport.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            status: 'FLAGGED',
            is_eligible: false,
            remarks: 'Prior remark',
          }),
        }),
      );
    });

    it('skips the email when the scholar has no account email', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(
        makeReport({
          scholar_profile: {
            profile_id: 11,
            first_name: 'Ana',
            last_name: 'Santos',
            user: null,
          },
        }),
      );

      await service.updateGradeReportStatus(7, 71, dto);

      expect(mail.sendGradeReportStatusUpdated).not.toHaveBeenCalled();
    });
  });
});
