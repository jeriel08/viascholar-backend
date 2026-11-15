import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TermEnrollmentController } from './term-enrollment.controller.js';
import { ScholarEnrollmentService } from './services/scholar-enrollment.service.js';
import { CoordinatorEnrollmentService } from './services/coordinator-enrollment.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { SubmitEnrollmentDto } from './dto/submit-enrollment.dto.js';
import type { ReviewEnrollmentDto } from './dto/review-enrollment.dto.js';

const makeRequest = (userId = 7, role: Role = Role.SCHOLAR) => ({
  user: { user_id: userId, role },
});

const makeFile = (
  size: number,
  name = 'cor.pdf',
  mimetype = 'application/pdf',
): Express.Multer.File =>
  ({
    originalname: name,
    mimetype,
    size,
    buffer: Buffer.alloc(Math.min(size, 16), 1),
  }) as Express.Multer.File;

const makeSubmitDto = (): SubmitEnrollmentDto => ({
  academic_year: '2026-2027',
  semester: '1st Semester',
  year_level: 2,
  total_units: 15,
  total_assessment: 12000,
  enrolled_subjects: [
    {
      subject_code: 'IT 101',
      descriptive_title: 'Intro to IT',
      units: 3,
    },
  ],
});

describe('TermEnrollmentController', () => {
  let controller: TermEnrollmentController;
  let scholarMock: Record<string, ReturnType<typeof vi.fn>>;
  let coordinatorMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    scholarMock = {
      getCurrentEnrollment: vi.fn(),
      uploadAndParseCor: vi.fn(),
      uploadAndParseSoa: vi.fn(),
      uploadAndParseConsolidated: vi.fn(),
      saveDraft: vi.fn(),
      runPreAudit: vi.fn(),
      submitEnrollment: vi.fn(),
      discardDraft: vi.fn(),
      clearDraftDocument: vi.fn(),
    };
    coordinatorMock = {
      getPendingEnrollments: vi.fn(),
      getEnrollmentDetails: vi.fn(),
      reviewEnrollment: vi.fn(),
      grantorAuthorizeDisbursement: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TermEnrollmentController],
      providers: [
        { provide: ScholarEnrollmentService, useValue: scholarMock },
        { provide: CoordinatorEnrollmentService, useValue: coordinatorMock },
      ],
    }).compile();

    controller = module.get<TermEnrollmentController>(TermEnrollmentController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  describe('delegation', () => {
    it('delegates current enrollment with the user and optional term filters', async () => {
      await controller.getCurrentEnrollment(
        makeRequest(),
        '2026-2027',
        '1st Semester',
      );
      await controller.getCurrentEnrollment(makeRequest());

      expect(scholarMock.getCurrentEnrollment).toHaveBeenNthCalledWith(
        1,
        7,
        '2026-2027',
        '1st Semester',
      );
      expect(scholarMock.getCurrentEnrollment).toHaveBeenNthCalledWith(
        2,
        7,
        undefined,
        undefined,
      );
    });

    it('delegates COR uploads with the authenticated user and the first file', () => {
      const files = [makeFile(100, 'cor.pdf'), makeFile(100, 'extra.png')];

      void controller.uploadCor(makeRequest(3), files);

      expect(scholarMock.uploadAndParseCor).toHaveBeenCalledWith(3, files[0]);
    });

    it('delegates SOA uploads with the authenticated user and the first file', () => {
      const files = [makeFile(100, 'soa.pdf')];

      void controller.uploadSoa(makeRequest(3), files);

      expect(scholarMock.uploadAndParseSoa).toHaveBeenCalledWith(3, files[0]);
    });

    it('delegates consolidated uploads with the authenticated user and the first file', () => {
      const files = [makeFile(100, 'matriculation.pdf')];

      void controller.uploadConsolidated(makeRequest(3), files);

      expect(scholarMock.uploadAndParseConsolidated).toHaveBeenCalledWith(
        3,
        files[0],
      );
    });

    it('delegates draft saves with the user and dto', () => {
      const dto = makeSubmitDto();

      void controller.saveDraft(makeRequest(3), dto);

      expect(scholarMock.saveDraft).toHaveBeenCalledWith(3, dto);
    });

    it('delegates pre-audit with the user and dto', () => {
      const dto = makeSubmitDto();

      void controller.preAudit(makeRequest(3), dto);

      expect(scholarMock.runPreAudit).toHaveBeenCalledWith(3, dto);
    });

    it('delegates final submission with the user and dto', () => {
      const dto = makeSubmitDto();

      void controller.submitEnrollment(makeRequest(3), dto);

      expect(scholarMock.submitEnrollment).toHaveBeenCalledWith(3, dto);
    });

    it('delegates draft discard with the user and optional term filters', () => {
      void controller.discardDraft(makeRequest(3), '2026-2027', 'Summer');
      void controller.discardDraft(makeRequest(3));

      expect(scholarMock.discardDraft).toHaveBeenNthCalledWith(
        1,
        3,
        '2026-2027',
        'Summer',
      );
      expect(scholarMock.discardDraft).toHaveBeenNthCalledWith(
        2,
        3,
        undefined,
        undefined,
      );
    });

    it('delegates clearing a specific draft document type', () => {
      void controller.clearDraftDocument(makeRequest(3), 'consolidated');

      expect(scholarMock.clearDraftDocument).toHaveBeenCalledWith(
        3,
        'consolidated',
      );
    });

    it('delegates the pending queue with search and status filters', () => {
      void controller.getPendingEnrollments('ana', 'PENDING_REVIEW');
      void controller.getPendingEnrollments();

      expect(coordinatorMock.getPendingEnrollments).toHaveBeenNthCalledWith(
        1,
        'ana',
        'PENDING_REVIEW',
      );
      expect(coordinatorMock.getPendingEnrollments).toHaveBeenNthCalledWith(
        2,
        undefined,
        undefined,
      );
    });

    it('delegates enrollment detail lookup with the parsed id', () => {
      void controller.getEnrollmentDetails(55);

      expect(coordinatorMock.getEnrollmentDetails).toHaveBeenCalledWith(55);
    });

    it('delegates review actions with the user, parsed id, and dto', () => {
      const dto = {
        action: 'APPROVE',
        coordinator_notes: 'Looks good',
      } as ReviewEnrollmentDto;

      void controller.reviewEnrollment(
        makeRequest(9, Role.COORDINATOR),
        55,
        dto,
      );

      expect(coordinatorMock.reviewEnrollment).toHaveBeenCalledWith(9, 55, dto);
    });

    it('delegates grantor disbursement authorization with the user, id, and dto', () => {
      const dto = {
        remarks: 'Approved',
        check_number: 'CHK-1',
        payment_method: 'BANK_TRANSFER',
      };

      void controller.authorizeDisbursement(
        makeRequest(4, Role.GRANTOR),
        55,
        dto,
      );

      expect(coordinatorMock.grantorAuthorizeDisbursement).toHaveBeenCalledWith(
        4,
        55,
        dto,
      );
    });
  });

  describe('file validation', () => {
    const fifteenMb = 15 * 1024 * 1024;

    it('rejects an empty file list before reaching the service', async () => {
      await expect(
        controller.uploadCor(makeRequest(), [] as Express.Multer.File[]),
      ).rejects.toThrow(
        new BadRequestException('At least one document file is required.'),
      );

      expect(scholarMock.uploadAndParseCor).not.toHaveBeenCalled();
    });

    it('rejects a missing file collection', async () => {
      await expect(
        controller.uploadCor(
          makeRequest(),
          undefined as unknown as Express.Multer.File[],
        ),
      ).rejects.toThrow(
        new BadRequestException('At least one document file is required.'),
      );
    });

    it.each([
      ['application/pdf', 'scan.pdf'],
      ['image/png', 'scan.png'],
      ['image/jpeg', 'scan.jpeg'],
      ['image/jpg', 'scan.jpg'],
      ['image/webp', 'scan.webp'],
    ])('accepts the allowed %s MIME type', (mimetype, name) => {
      const files = [makeFile(1024, name, mimetype)];

      void controller.uploadCor(makeRequest(3), files);

      expect(scholarMock.uploadAndParseCor).toHaveBeenCalledWith(3, files[0]);
    });

    it('accepts multiple valid files and forwards only the first one', () => {
      const files = [
        makeFile(1024, 'first.pdf', 'application/pdf'),
        makeFile(2048, 'second.png', 'image/png'),
      ];

      void controller.uploadCor(makeRequest(3), files);

      expect(scholarMock.uploadAndParseCor).toHaveBeenCalledWith(3, files[0]);
    });

    it('rejects an unsupported MIME type / extension with a descriptive message', async () => {
      const files = [makeFile(1024, 'notes.txt', 'text/plain')];

      await expect(controller.uploadCor(makeRequest(), files)).rejects.toThrow(
        new BadRequestException(
          'Unsupported file type (.txt) for "notes.txt". Only PDF, PNG, JPG, JPEG, and WEBP files are accepted.',
        ),
      );
    });

    it('rejects executable files even when sent with generic octet-stream MIME', async () => {
      const files = [makeFile(1024, 'payload.exe', 'application/octet-stream')];

      await expect(controller.uploadCor(makeRequest(), files)).rejects.toThrow(
        new BadRequestException(
          'Unsupported file type (.exe) for "payload.exe". Only PDF, PNG, JPG, JPEG, and WEBP files are accepted.',
        ),
      );
    });

    it('rejects files without an extension when MIME type is unsupported', async () => {
      const files = [makeFile(1024, 'README', 'text/plain')];

      await expect(controller.uploadCor(makeRequest(), files)).rejects.toThrow(
        new BadRequestException(
          'Unsupported file format for "README". Only PDF, PNG, JPG, JPEG, and WEBP files are accepted.',
        ),
      );
    });

    it('rejects an empty 0-byte file', async () => {
      const files = [makeFile(0, 'blank.pdf', 'application/pdf')];

      await expect(controller.uploadCor(makeRequest(), files)).rejects.toThrow(
        new BadRequestException(
          'File "blank.pdf" is empty. Please upload a readable PDF or image document.',
        ),
      );
    });

    it('validates every file in a multi-file upload', async () => {
      const files = [
        makeFile(1024, 'good.pdf', 'application/pdf'),
        makeFile(1024, 'bad.docx', 'application/vnd.openxmlformats'),
      ];

      await expect(controller.uploadCor(makeRequest(), files)).rejects.toThrow(
        new BadRequestException(
          'Unsupported file type (.docx) for "bad.docx". Only PDF, PNG, JPG, JPEG, and WEBP files are accepted.',
        ),
      );
    });

    it('accepts a file exactly at the 15 MB boundary', () => {
      const files = [makeFile(fifteenMb, 'limit.pdf')];

      void controller.uploadSoa(makeRequest(3), files);

      expect(scholarMock.uploadAndParseSoa).toHaveBeenCalledWith(3, files[0]);
    });

    it('rejects a file one byte over the 15 MB boundary', async () => {
      const files = [makeFile(fifteenMb + 1, 'too-big.pdf')];

      await expect(controller.uploadSoa(makeRequest(), files)).rejects.toThrow(
        new BadRequestException(
          'File too-big.pdf exceeds the maximum upload limit of 15 MB.',
        ),
      );
    });

    it('applies the same validation to consolidated uploads', async () => {
      await expect(
        controller.uploadConsolidated(makeRequest(), [
          makeFile(1024, 'envelope.zip', 'application/zip'),
        ]),
      ).rejects.toThrow(
        new BadRequestException(
          'Unsupported file type (.zip) for "envelope.zip". Only PDF, PNG, JPG, JPEG, and WEBP files are accepted.',
        ),
      );
      expect(scholarMock.uploadAndParseConsolidated).not.toHaveBeenCalled();
    });
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = TermEnrollmentController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('allows scholars, admins, and coordinators to read the current enrollment', () => {
      expect(rolesFor(handlerFor('getCurrentEnrollment'))).toEqual([
        Role.SCHOLAR,
        Role.ADMIN,
        Role.COORDINATOR,
      ]);
    });

    it('gates every scholar enrollment action to scholars only', () => {
      for (const name of [
        'uploadCor',
        'uploadSoa',
        'uploadConsolidated',
        'saveDraft',
        'preAudit',
        'submitEnrollment',
        'discardDraft',
        'clearDraftDocument',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([Role.SCHOLAR]);
      }
    });

    it('allows coordinators, admins, and grantors to monitor the enrollment queue', () => {
      expect(rolesFor(handlerFor('getPendingEnrollments'))).toEqual([
        Role.COORDINATOR,
        Role.ADMIN,
        Role.GRANTOR,
      ]);
      expect(rolesFor(handlerFor('getEnrollmentDetails'))).toEqual([
        Role.COORDINATOR,
        Role.ADMIN,
        Role.GRANTOR,
      ]);
    });

    it('gates review decisions to coordinators and admins', () => {
      expect(rolesFor(handlerFor('reviewEnrollment'))).toEqual([
        Role.COORDINATOR,
        Role.ADMIN,
      ]);
    });

    it('gates disbursement authorization to grantors and admins', () => {
      expect(rolesFor(handlerFor('authorizeDisbursement'))).toEqual([
        Role.GRANTOR,
        Role.ADMIN,
      ]);
    });
  });
});
