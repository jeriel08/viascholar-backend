import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CoordinatorDisbursementService } from './coordinator-disbursement.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import type {
  RecordCheckIssuanceDto,
  SettleOfficialReceiptDto,
} from '../dto/disbursement.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;

const createPrismaMock = () => ({
  employee: {
    findUnique: vi.fn(),
  },
  disbursement: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  scholarDocument: {
    update: vi.fn(),
  },
  $transaction: vi.fn(),
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});

const makeCoordinator = (overrides: Record<string, unknown> = {}) => ({
  employee_id: 201,
  first_name: 'Cora',
  last_name: 'Coordinator',
  ...overrides,
});

const makeDisbursement = (overrides: Record<string, unknown> = {}) => ({
  disbursement_id: 55,
  scholar_profile_id: 11,
  status: 'AUTHORIZED',
  amount: '12500.00',
  academic_year: '2026-2027',
  semester: '1st Semester',
  voucher_number: 'DV-2026-0001',
  check_number: null,
  bank_name: null,
  date_issued: null,
  date_claimed: null,
  remarks: 'Original remarks',
  or_document_id: 888,
  or_number: 'OR-123',
  scholar_profile: {
    profile_id: 11,
    user_id: 7,
    first_name: 'Juan',
    school_name: 'University of Mindanao',
  },
  or_document: { document_id: 888, status: 'PENDING' },
  ...overrides,
});

const checkDto = {
  check_number: ' 000123 ',
  bank_name: '  BPI  ',
  date_issued: '2026-08-03',
} as RecordCheckIssuanceDto;

const settleDto = {
  approved: true,
  remarks: 'Receipt matches',
} as SettleOfficialReceiptDto;

describe('CoordinatorDisbursementService', () => {
  let service: CoordinatorDisbursementService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();

    prisma.employee.findUnique.mockResolvedValue(makeCoordinator());
    prisma.disbursement.findMany.mockResolvedValue([]);
    prisma.disbursement.findUnique.mockResolvedValue(makeDisbursement());
    prisma.disbursement.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        makeDisbursement({ ...data }),
    );
    prisma.scholarDocument.update.mockResolvedValue({ document_id: 888 });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          scholarDocument: prisma.scholarDocument,
          disbursement: prisma.disbursement,
        }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoordinatorDisbursementService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get<CoordinatorDisbursementService>(
      CoordinatorDisbursementService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getDisbursementsQueue', () => {
    it('returns every disbursement when no filters are provided', async () => {
      await service.getDisbursementsQueue();

      const call = prisma.disbursement.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
      };
      expect(call.where).toEqual({});
      expect(call.orderBy).toEqual({ updated_at: 'desc' });
    });

    it('ignores the ALL status filter but applies specific statuses', async () => {
      await service.getDisbursementsQueue({ status: 'ALL' });
      let call = prisma.disbursement.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.status).toBeUndefined();

      await service.getDisbursementsQueue({ status: 'CHECK_ISSUED' });
      call = prisma.disbursement.findMany.mock.calls[1][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.status).toBe('CHECK_ISSUED');
    });

    it('applies academic year and semester filters', async () => {
      await service.getDisbursementsQueue({
        academicYear: '2026-2027',
        semester: '2nd Semester',
      });

      const call = prisma.disbursement.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.academic_year).toBe('2026-2027');
      expect(call.where.semester).toBe('2nd Semester');
    });

    it('filters by school name case-insensitively', async () => {
      await service.getDisbursementsQueue({ school: 'mindanao' });

      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: objectMatching({
            scholar_profile: {
              school_name: { contains: 'mindanao', mode: 'insensitive' },
            },
          }),
        }),
      );
    });

    it('builds a six-field OR search for the search term', async () => {
      await service.getDisbursementsQueue({ search: '  123  ' });

      const call = prisma.disbursement.findMany.mock.calls[0][0] as {
        where: { OR: Array<Record<string, unknown>> };
      };
      expect(call.where.OR).toEqual([
        { check_number: { contains: '123', mode: 'insensitive' } },
        { voucher_number: { contains: '123', mode: 'insensitive' } },
        { or_number: { contains: '123', mode: 'insensitive' } },
        {
          scholar_profile: {
            first_name: { contains: '123', mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            last_name: { contains: '123', mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            student_number: { contains: '123', mode: 'insensitive' },
          },
        },
      ]);
    });
  });

  describe('recordCheckIssuance', () => {
    it('throws NotFoundException when the coordinator employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.recordCheckIssuance(7, 55, checkDto),
      ).rejects.toThrow(
        new NotFoundException('Coordinator employee record not found.'),
      );
    });

    it('throws NotFoundException when the disbursement does not exist', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(null);

      await expect(
        service.recordCheckIssuance(7, 999, checkDto),
      ).rejects.toThrow(new NotFoundException('Disbursement #999 not found.'));
    });

    it('throws BadRequestException when the disbursement was already settled', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ status: 'SETTLED' }),
      );

      await expect(
        service.recordCheckIssuance(7, 55, checkDto),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot issue check for disbursement with status "SETTLED".',
        ),
      );
    });

    it.each(['AUTHORIZED', 'RELEASED', 'PENDING'])(
      'allows recording a check when the status is %s',
      async (status) => {
        prisma.disbursement.findUnique.mockResolvedValue(
          makeDisbursement({ status }),
        );

        const result = await service.recordCheckIssuance(7, 55, checkDto);

        expect(result.message).toBe(
          'Check issuance details successfully recorded.',
        );
        expect(prisma.disbursement.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { disbursement_id: 55 },
            data: objectMatching({ status: 'CHECK_ISSUED' }),
          }),
        );
      },
    );

    it('locks the payee to the school name and trims check fields', async () => {
      await service.recordCheckIssuance(7, 55, {
        ...checkDto,
        voucher_number: '  DV-OVERRIDE  ',
        payment_method: 'DIRECT_TO_SCHOOL_CHECK',
      });

      expect(prisma.disbursement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({
            check_payee: 'University of Mindanao',
            check_number: '000123',
            bank_name: 'BPI',
            voucher_number: 'DV-OVERRIDE',
            payment_method: 'DIRECT_TO_SCHOOL_CHECK',
          }),
        }),
      );
    });

    it('preserves the original voucher number when none is provided', async () => {
      await service.recordCheckIssuance(7, 55, checkDto);

      expect(prisma.disbursement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({ voucher_number: 'DV-2026-0001' }),
        }),
      );
    });

    it('falls back to the generic cashier label when the school is unknown', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({
          scholar_profile: { profile_id: 11, user_id: 7, school_name: null },
        }),
      );

      await service.recordCheckIssuance(7, 55, checkDto);

      expect(prisma.disbursement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({
            check_payee: 'Registered University Cashier',
          }),
        }),
      );
    });

    it('appends the remarks and audits the issuance', async () => {
      await service.recordCheckIssuance(7, 55, {
        ...checkDto,
        remarks: 'Released to RO cashier',
      });

      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { remarks: string };
      };
      expect(updateCall.data.remarks).toContain('Original remarks');
      expect(updateCall.data.remarks).toContain('Released to RO cashier');
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'RECORD_CHECK_ISSUANCE',
        expect.stringContaining('000123'),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'disbursement:updated',
        objectMatching({ status: 'CHECK_ISSUED', check_number: '000123' }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'disbursement:updated',
        objectMatching({ status: 'CHECK_ISSUED' }),
      );
    });
  });

  describe('settleOfficialReceipt', () => {
    it('throws NotFoundException when the coordinator employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.settleOfficialReceipt(7, 55, settleDto),
      ).rejects.toThrow(
        new NotFoundException('Coordinator employee record not found.'),
      );
    });

    it('throws NotFoundException when the disbursement does not exist', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(null);

      await expect(
        service.settleOfficialReceipt(7, 999, settleDto),
      ).rejects.toThrow(new NotFoundException('Disbursement #999 not found.'));
    });

    it('throws BadRequestException when the disbursement is in a non-settleable status', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ status: 'AUTHORIZED' }),
      );

      await expect(
        service.settleOfficialReceipt(7, 55, settleDto),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot settle disbursement with status "AUTHORIZED".',
        ),
      );
    });

    it.each(['OR_SUBMITTED', 'CHECK_ISSUED'])(
      'approves the receipt when the status is %s',
      async (status) => {
        prisma.disbursement.findUnique.mockResolvedValue(
          makeDisbursement({ status }),
        );

        const result = await service.settleOfficialReceipt(7, 55, settleDto);

        expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
          where: { document_id: 888 },
          data: objectMatching({
            status: 'VERIFIED',
            reviewed_by_employee_id: 201,
            verified_at: anyArg(Date),
          }),
        });
        expect(prisma.disbursement.update).toHaveBeenCalledWith(
          objectMatching({
            where: { disbursement_id: 55 },
            data: objectMatching({
              status: 'SETTLED',
              settled_by_employee_id: 201,
              or_verified_at: anyArg(Date),
              settled_at: anyArg(Date),
            }),
          }),
        );
        expect(audit.log).toHaveBeenCalledWith(
          7,
          'SETTLE_DISBURSEMENT_OR',
          expect.stringContaining('disbursement #55'),
        );
        expect(events.emitToStaff).toHaveBeenCalledWith(
          'disbursement:updated',
          objectMatching({ status: 'SETTLED' }),
        );
        expect(events.emitToUser).toHaveBeenCalledWith(
          7,
          'disbursement:updated',
          objectMatching({ status: 'SETTLED' }),
        );
        expect(result.message).toBe(
          'Disbursement successfully settled and verified.',
        );
      },
    );

    it('skips the document verification when no or_document_id is present', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ status: 'CHECK_ISSUED', or_document_id: null }),
      );

      await service.settleOfficialReceipt(7, 55, settleDto);

      expect(prisma.scholarDocument.update).not.toHaveBeenCalled();
      expect(prisma.disbursement.update).toHaveBeenCalled();
    });

    it('remarks include the settlement note when remarks are provided', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ status: 'CHECK_ISSUED', remarks: 'Prior note' }),
      );

      await service.settleOfficialReceipt(7, 55, settleDto);

      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { remarks: string };
      };
      expect(updateCall.data.remarks).toContain('Prior note');
      expect(updateCall.data.remarks).toContain('Settlement: Receipt matches');
    });

    it('rejects the receipt and moves it back to CHECK_ISSUED for re-upload', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ status: 'OR_SUBMITTED', remarks: 'Prior note' }),
      );

      const result = await service.settleOfficialReceipt(7, 55, {
        approved: false,
        rejection_reason: 'Blurry photo',
      });

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 888 },
        data: objectMatching({
          status: 'NEEDS_REUPLOAD',
          rejection_reason: 'Blurry photo',
          reviewed_by_employee_id: 201,
        }),
      });
      expect(prisma.disbursement.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ status: 'CHECK_ISSUED' }),
        }),
      );
      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { remarks: string };
      };
      expect(updateCall.data.remarks).toContain('OR Rejected: Blurry photo');
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'disbursement:updated',
        objectMatching({
          status: 'CHECK_ISSUED',
          message: 'Official Receipt rejected: Blurry photo',
        }),
      );
      expect(result.message).toBe('Official Receipt marked for re-upload.');
    });

    it('uses the default rejection message when none is provided', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ status: 'OR_SUBMITTED', or_document_id: null }),
      );

      await service.settleOfficialReceipt(7, 55, {
        approved: false,
      });

      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { remarks: string };
      };
      expect(updateCall.data.remarks).toContain(
        'OR Rejected: Please re-upload receipt photo.',
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'disbursement:updated',
        objectMatching({
          message: 'Official Receipt rejected: Please re-upload a clear photo.',
        }),
      );
    });
  });
});
