import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { DisbursementsController } from './disbursements.controller.js';
import { GrantorDisbursementService } from './services/grantor-disbursement.service.js';
import { CoordinatorDisbursementService } from './services/coordinator-disbursement.service.js';
import { ScholarDisbursementService } from './services/scholar-disbursement.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { AuthorizeDisbursementBatchDto } from './dto/disbursement.dto.js';
import type { RecordCheckIssuanceDto } from './dto/disbursement.dto.js';
import type { SettleOfficialReceiptDto } from './dto/disbursement.dto.js';
import type { SubmitOfficialReceiptDto } from './dto/disbursement.dto.js';

const makeRequest = (userId = 7) => ({
  user: { user_id: userId, role: Role.SCHOLAR },
});

describe('DisbursementsController', () => {
  let controller: DisbursementsController;
  let grantorMock: Record<string, ReturnType<typeof vi.fn>>;
  let coordinatorMock: Record<string, ReturnType<typeof vi.fn>>;
  let scholarMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    grantorMock = {
      getConsolidatedBillingReport: vi.fn(),
      authorizeBatch: vi.fn(),
      getVoucherDetails: vi.fn(),
    };
    coordinatorMock = {
      getDisbursementsQueue: vi.fn(),
      recordCheckIssuance: vi.fn(),
      settleOfficialReceipt: vi.fn(),
    };
    scholarMock = {
      uploadAndScanReceipt: vi.fn(),
      getMyDisbursements: vi.fn(),
      submitOfficialReceipt: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisbursementsController],
      providers: [
        { provide: GrantorDisbursementService, useValue: grantorMock },
        { provide: CoordinatorDisbursementService, useValue: coordinatorMock },
        { provide: ScholarDisbursementService, useValue: scholarMock },
      ],
    }).compile();

    controller = module.get<DisbursementsController>(DisbursementsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates the consolidated report with both query filters', () => {
    void controller.getConsolidatedBillingReport('2026-2027', '1st Semester');

    expect(grantorMock.getConsolidatedBillingReport).toHaveBeenCalledWith(
      '2026-2027',
      '1st Semester',
    );
  });

  it('delegates authorizeBatch with the authenticated user and dto', () => {
    const dto = { disbursement_ids: [1, 2] } as AuthorizeDisbursementBatchDto;

    void controller.authorizeBatch(makeRequest(42), dto);

    expect(grantorMock.authorizeBatch).toHaveBeenCalledWith(42, dto);
  });

  it('delegates getVoucherDetails with the voucher param', () => {
    void controller.getVoucherDetails('DV-2026-0001');

    expect(grantorMock.getVoucherDetails).toHaveBeenCalledWith('DV-2026-0001');
  });

  it('delegates the queue with an options object built from the query params', () => {
    void controller.getDisbursementsQueue(
      'PENDING',
      'mindanao',
      '123',
      '2026-2027',
      '2nd Semester',
    );

    expect(coordinatorMock.getDisbursementsQueue).toHaveBeenCalledWith({
      status: 'PENDING',
      school: 'mindanao',
      search: '123',
      academicYear: '2026-2027',
      semester: '2nd Semester',
    });
  });

  it('delegates recordCheckIssuance with user, parsed id, and dto', () => {
    const dto = { check_number: '000123' } as RecordCheckIssuanceDto;

    void controller.recordCheckIssuance(makeRequest(9), 55, dto);

    expect(coordinatorMock.recordCheckIssuance).toHaveBeenCalledWith(
      9,
      55,
      dto,
    );
  });

  it('delegates settleOfficialReceipt with user, parsed id, and dto', () => {
    const dto = { approved: true } as SettleOfficialReceiptDto;

    void controller.settleOfficialReceipt(makeRequest(9), 55, dto);

    expect(coordinatorMock.settleOfficialReceipt).toHaveBeenCalledWith(
      9,
      55,
      dto,
    );
  });

  it('delegates uploadReceipt with the authenticated user and files', () => {
    const files = [{ originalname: 'or.png' }] as Express.Multer.File[];

    void controller.uploadReceipt(makeRequest(3), files);

    expect(scholarMock.uploadAndScanReceipt).toHaveBeenCalledWith(3, files);
  });

  it('delegates getMyDisbursements with the authenticated user', () => {
    void controller.getMyDisbursements(makeRequest(3));

    expect(scholarMock.getMyDisbursements).toHaveBeenCalledWith(3);
  });

  it('delegates submitOfficialReceipt with user, parsed id, and dto', () => {
    const dto = { or_number: 'OR-123' } as SubmitOfficialReceiptDto;

    void controller.submitOfficialReceipt(makeRequest(3), 55, dto);

    expect(scholarMock.submitOfficialReceipt).toHaveBeenCalledWith(3, 55, dto);
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = DisbursementsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('gates grantor report and authorization to grantor and admin', () => {
      for (const name of ['getConsolidatedBillingReport', 'authorizeBatch']) {
        expect(rolesFor(handlerFor(name))).toEqual([Role.GRANTOR, Role.ADMIN]);
      }
    });

    it('gates voucher details to grantor, coordinator, and admin', () => {
      expect(rolesFor(handlerFor('getVoucherDetails'))).toEqual([
        Role.GRANTOR,
        Role.COORDINATOR,
        Role.ADMIN,
      ]);
    });

    it('gates the queue to coordinator, grantor, and admin', () => {
      expect(rolesFor(handlerFor('getDisbursementsQueue'))).toEqual([
        Role.COORDINATOR,
        Role.GRANTOR,
        Role.ADMIN,
      ]);
    });

    it('gates check issuance and OR settlement to coordinator and admin', () => {
      for (const name of ['recordCheckIssuance', 'settleOfficialReceipt']) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.COORDINATOR,
          Role.ADMIN,
        ]);
      }
    });

    it('gates the scholar endpoints to scholars only', () => {
      for (const name of [
        'uploadReceipt',
        'getMyDisbursements',
        'submitOfficialReceipt',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([Role.SCHOLAR]);
      }
    });
  });
});
