import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GrantorDisbursementService } from './grantor-disbursement.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import type { AuthorizeDisbursementBatchDto } from '../dto/disbursement.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;

const createPrismaMock = () => ({
  employee: {
    findUnique: vi.fn(),
  },
  disbursement: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});

const makeGrantor = (overrides: Record<string, unknown> = {}) => ({
  employee_id: 101,
  first_name: 'Gail',
  last_name: 'Grantor',
  ...overrides,
});

const makeDisbursement = (overrides: Record<string, unknown> = {}) => ({
  disbursement_id: 1,
  scholar_profile_id: 11,
  status: 'PENDING',
  amount: '12500.00',
  academic_year: '2026-2027',
  semester: '1st Semester',
  voucher_number: null,
  check_payee: null,
  payment_method: null,
  remarks: null,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-02T00:00:00.000Z'),
  scholar_profile: {
    profile_id: 11,
    user_id: 7,
    school_name: 'University of Mindanao',
  },
  ...overrides,
});

const authorizeDto = {
  disbursement_ids: [1, 2],
} as AuthorizeDisbursementBatchDto;

describe('GrantorDisbursementService', () => {
  let service: GrantorDisbursementService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;

  let lastFindManyTargets: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    lastFindManyTargets = [];
    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();

    prisma.employee.findUnique.mockResolvedValue(makeGrantor());
    prisma.disbursement.count.mockResolvedValue(5);
    prisma.disbursement.findMany.mockImplementation(() =>
      Promise.resolve(lastFindManyTargets),
    );
    prisma.disbursement.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { disbursement_id: number };
        data: Record<string, unknown>;
      }) => {
        const target = lastFindManyTargets.find(
          (t) => t.disbursement_id === where.disbursement_id,
        );
        return Promise.resolve(
          makeDisbursement({ ...target, ...where, ...data }),
        );
      },
    );
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ disbursement: prisma.disbursement }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrantorDisbursementService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get<GrantorDisbursementService>(
      GrantorDisbursementService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getConsolidatedBillingReport', () => {
    it('queries disbursements in billing statuses, newest first, without filters', async () => {
      await service.getConsolidatedBillingReport();

      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: objectMatching({
            status: {
              in: [
                'PENDING',
                'AUTHORIZED',
                'RELEASED',
                'CHECK_ISSUED',
                'OR_SUBMITTED',
                'SETTLED',
              ],
            },
          }),
          orderBy: { created_at: 'desc' },
        }),
      );
      const whereArg = prisma.disbursement.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(whereArg.where.academic_year).toBeUndefined();
      expect(whereArg.where.semester).toBeUndefined();
    });

    it('applies academic year and semester filters when provided', async () => {
      await service.getConsolidatedBillingReport('2026-2027', '1st Semester');

      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: objectMatching({
            academic_year: '2026-2027',
            semester: '1st Semester',
          }),
        }),
      );
    });

    it('groups disbursements by school with status-specific totals', async () => {
      lastFindManyTargets = [
        makeDisbursement({
          status: 'PENDING',
          amount: '10000.00',
          scholar_profile: { profile_id: 11, user_id: 7, school_name: 'UM' },
        }),
        makeDisbursement({
          disbursement_id: 2,
          status: 'AUTHORIZED',
          amount: '5000.00',
          scholar_profile: { profile_id: 12, user_id: 8, school_name: 'UM' },
        }),
        makeDisbursement({
          disbursement_id: 3,
          status: 'SETTLED',
          amount: '7000.00',
          scholar_profile: { profile_id: 13, user_id: 9, school_name: 'UM' },
        }),
        makeDisbursement({
          disbursement_id: 4,
          status: 'RELEASED',
          amount: '20000.00',
          scholar_profile: { profile_id: 14, user_id: 10, school_name: 'UIC' },
        }),
      ];

      const report = await service.getConsolidatedBillingReport();

      const um = report.find((r) => r.school_name === 'UM');
      expect(um).toBeDefined();
      expect(um?.total_amount).toBe(22000);
      expect(um?.authorized_amount).toBe(5000);
      expect(um?.settled_amount).toBe(7000);
      expect(um?.pending_amount).toBe(10000);
      expect(um?.pending_count).toBe(1);
      expect(um?.total_scholars).toBe(3);
      expect(um?.disbursements).toHaveLength(3);

      const uic = report.find((r) => r.school_name === 'UIC');
      expect(uic?.total_amount).toBe(20000);
      expect(uic?.authorized_amount).toBe(20000);
      expect(uic?.total_scholars).toBe(1);
    });

    it('groups disbursements without a school under Unassigned University', async () => {
      prisma.disbursement.findMany.mockResolvedValue([
        makeDisbursement({
          disbursement_id: 9,
          scholar_profile: null,
          amount: '3000.00',
        }),
      ]);

      const report = await service.getConsolidatedBillingReport();

      expect(report[0].school_name).toBe('Unassigned University');
      expect(report[0].total_scholars).toBe(1);
      expect(report[0].total_amount).toBe(3000);
    });
  });

  describe('authorizeBatch', () => {
    it('throws BadRequestException when no disbursements are selected', async () => {
      await expect(
        service.authorizeBatch(7, {
          disbursement_ids: [],
        }),
      ).rejects.toThrow(
        new BadRequestException('No disbursements selected for authorization.'),
      );
    });

    it('throws NotFoundException when the grantor employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.authorizeBatch(7, authorizeDto)).rejects.toThrow(
        new NotFoundException('Grantor employee record not found.'),
      );
    });

    it('generates a sequential DV-YYYY-XXXX voucher based on existing vouchers', async () => {
      const year = new Date().getFullYear();
      prisma.disbursement.count.mockResolvedValue(41);
      lastFindManyTargets = [makeDisbursement()];

      const result = await service.authorizeBatch(7, authorizeDto);

      expect(result.voucher_number).toBe(`DV-${year}-0042`);
      expect(prisma.disbursement.count).toHaveBeenCalledWith({
        where: { voucher_number: { startsWith: `DV-${year}` } },
      });
    });

    it('throws BadRequestException when none of the IDs match a pending disbursement', async () => {
      lastFindManyTargets = [];

      await expect(service.authorizeBatch(7, authorizeDto)).rejects.toThrow(
        new BadRequestException(
          'No pending disbursements found matching the provided IDs.',
        ),
      );
    });

    it('authorizes the pending disbursements with the locked school payee', async () => {
      const target = makeDisbursement({
        disbursement_id: 1,
        amount: '8000.00',
        remarks: 'First tr??',
        scholar_profile: {
          profile_id: 11,
          user_id: 7,
          school_name: 'University of Mindanao',
        },
      });
      lastFindManyTargets = [target];

      const result = await service.authorizeBatch(7, {
        disbursement_ids: [1],
        remarks: 'Approved for release',
      });

      expect(prisma.disbursement.update).toHaveBeenCalledWith(
        objectMatching({
          where: { disbursement_id: 1 },
          data: objectMatching({
            status: 'AUTHORIZED',
            check_payee: 'University of Mindanao',
            payment_method: 'DIRECT_TO_SCHOOL_CHECK',
            approved_by_employee_id: 101,
          }),
        }),
      );
      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { remarks: string; voucher_number: string };
      };
      expect(updateCall.data.voucher_number).toBe(result.voucher_number);
      expect(updateCall.data.remarks).toContain('Grantor Voucher');
      expect(updateCall.data.remarks).toContain('Approved for release');

      expect(result.total_amount).toBe(8000);
      expect(result.disbursements).toHaveLength(1);
    });

    it('falls back to University Cashier and existing remarks when missing', async () => {
      const target = makeDisbursement({
        disbursement_id: 2,
        amount: '6000.00',
        remarks: 'keep me',
        scholar_profile: { profile_id: 12, user_id: 8, school_name: null },
      });
      lastFindManyTargets = [target];

      await service.authorizeBatch(7, {
        disbursement_ids: [2],
      });

      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { check_payee: string; remarks: string };
      };
      expect(updateCall.data.check_payee).toBe('University Cashier');
      expect(updateCall.data.remarks).toBe('keep me');
    });

    it('logs the audit entry and emits staff and per-scholar events', async () => {
      const year = new Date().getFullYear();
      prisma.disbursement.count.mockResolvedValue(0);
      lastFindManyTargets = [
        makeDisbursement({ disbursement_id: 1, amount: '8000.00' }),
        makeDisbursement({
          disbursement_id: 2,
          amount: '4000.00',
          scholar_profile: { profile_id: 12, user_id: 8, school_name: 'UIC' },
        }),
      ];

      const result = await service.authorizeBatch(7, authorizeDto);

      const voucher = `DV-${year}-0001`;
      expect(result.voucher_number).toBe(voucher);
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'GRANTOR_AUTHORIZE_DISBURSEMENT_BATCH',
        stringMatching(new RegExp(voucher)),
      );
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'GRANTOR_AUTHORIZE_DISBURSEMENT_BATCH',
        stringMatching(/12000/),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'disbursement:authorized',
        objectMatching({
          voucher_number: voucher,
          count: 2,
          total_amount: 12000,
        }),
      );
      expect(events.emitToUser).toHaveBeenCalledTimes(2);
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'disbursement:updated',
        objectMatching({ status: 'AUTHORIZED', voucher_number: voucher }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        8,
        'disbursement:updated',
        objectMatching({ status: 'AUTHORIZED', voucher_number: voucher }),
      );
    });
  });

  describe('getVoucherDetails', () => {
    it('throws NotFoundException when no disbursements carry the voucher', async () => {
      prisma.disbursement.findMany.mockResolvedValue([]);

      await expect(service.getVoucherDetails('DV-2026-0001')).rejects.toThrow(
        new NotFoundException('Disbursement Voucher DV-2026-0001 not found.'),
      );
    });

    it('returns the voucher summary with totals and named approver', async () => {
      prisma.disbursement.findMany.mockResolvedValue([
        makeDisbursement({
          amount: '8000.00',
          check_payee: 'UM Cashier',
          authorized_at: undefined,
          updated_at: new Date('2026-08-05T00:00:00.000Z'),
          approved_by_employee: {
            first_name: 'Gail',
            last_name: 'Grantor',
          },
        }),
        makeDisbursement({
          disbursement_id: 2,
          amount: '4000.00',
          check_payee: 'UM Cashier',
          approved_by_employee: {
            first_name: 'Gail',
            last_name: 'Grantor',
          },
        }),
      ]);

      const result = await service.getVoucherDetails('DV-2026-0001');

      expect(result.voucher_number).toBe('DV-2026-0001');
      expect(result.total_amount).toBe(12000);
      expect(result.item_count).toBe(2);
      expect(result.authorized_by).toBe('Gail Grantor');
      expect(result.payee_school).toBe('UM Cashier');
      expect(result.items).toHaveLength(2);
    });

    it('falls back to Grantor Office and the school name when approver info is missing', async () => {
      prisma.disbursement.findMany.mockResolvedValue([
        makeDisbursement({
          amount: '8000.00',
          check_payee: null,
          approved_by_employee: null,
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            school_name: 'University of Mindanao',
          },
        }),
      ]);

      const result = await service.getVoucherDetails('DV-2026-0002');

      expect(result.authorized_by).toBe('Grantor Office');
      expect(result.payee_school).toBe('University of Mindanao');
    });
  });
});
