import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentsController } from './documents.controller.js';
import { DocumentsStorageService } from './services/documents-storage.service.js';
import { DocumentOcrService } from './services/document-ocr.service.js';
import { DocumentEvaluationService } from './services/document-evaluation.service.js';
import { GradeReportsService } from './services/grade-reports.service.js';
import { AcademicAppealService } from './services/academic-appeal.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { VerifyDocumentDto } from './dto/verify-document.dto.js';
import type { ConfirmDocumentDto } from './dto/confirm-document.dto.js';
import type { QueryGradeReportsDto } from './dto/query-grade-reports.dto.js';
import type { UpdateGradeReportStatusDto } from './dto/update-grade-report-status.dto.js';
import type { SubmitAppealDto } from './dto/submit-appeal.dto.js';
import type { ReviewAppealDto } from './dto/review-appeal.dto.js';

const makeRequest = (userId = 7, role: Role = Role.SCHOLAR) => ({
  user: { user_id: userId, role },
});

const makeFile = (
  size: number,
  name = 'card.pdf',
  mimetype = 'application/pdf',
): Express.Multer.File =>
  ({
    originalname: name,
    mimetype,
    size,
    buffer: Buffer.alloc(Math.min(size, 16), 1),
  }) as Express.Multer.File;

describe('DocumentsController', () => {
  let controller: DocumentsController;
  let storageMock: Record<string, ReturnType<typeof vi.fn>>;
  let ocrMock: Record<string, ReturnType<typeof vi.fn>>;
  let evaluationMock: Record<string, ReturnType<typeof vi.fn>>;
  let gradeReportsMock: Record<string, ReturnType<typeof vi.fn>>;
  let appealMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    storageMock = {
      getAllowedDocumentTypes: vi.fn(),
      uploadDocument: vi.fn(),
      replaceDocument: vi.fn(),
      deleteDocument: vi.fn(),
      getMyDocuments: vi.fn(),
      getPendingDocuments: vi.fn(),
      getDocumentDetail: vi.fn(),
    };
    ocrMock = {
      getExtractedData: vi.fn(),
      retryDocumentOcr: vi.fn(),
    };
    evaluationMock = {
      confirmDocument: vi.fn(),
      requestChanges: vi.fn(),
      verifyAndEvaluate: vi.fn(),
      staffVerifyDocument: vi.fn(),
    };
    gradeReportsMock = {
      getMyGradeReports: vi.fn(),
      getAllGradeReports: vi.fn(),
      updateGradeReportStatus: vi.fn(),
    };
    appealMock = {
      submitAppeal: vi.fn(),
      reviewAppeal: vi.fn(),
      getPendingAppeals: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        { provide: DocumentsStorageService, useValue: storageMock },
        { provide: DocumentOcrService, useValue: ocrMock },
        { provide: DocumentEvaluationService, useValue: evaluationMock },
        { provide: GradeReportsService, useValue: gradeReportsMock },
        { provide: AcademicAppealService, useValue: appealMock },
      ],
    }).compile();

    controller = module.get<DocumentsController>(DocumentsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  describe('delegation', () => {
    it('delegates getAllowedDocumentTypes with the authenticated user', () => {
      void controller.getAllowedDocumentTypes(makeRequest(3));

      expect(storageMock.getAllowedDocumentTypes).toHaveBeenCalledWith(3);
    });

    it('delegates uploadDocument with the user, files, and document type', () => {
      const files = [makeFile(10)];

      void controller.uploadDocument(makeRequest(3), files, 'TOR');

      expect(storageMock.uploadDocument).toHaveBeenCalledWith(3, files, 'TOR');
    });

    it('defaults the document type to TOR when the body field is missing', () => {
      const files = [makeFile(10)];

      void controller.uploadDocument(
        makeRequest(3),
        files,
        undefined as unknown as string,
      );

      expect(storageMock.uploadDocument).toHaveBeenCalledWith(3, files, 'TOR');
    });

    it('delegates replaceDocument with the user, parsed id, and files', () => {
      const files = [makeFile(10)];

      void controller.replaceDocument(makeRequest(3), 55, files);

      expect(storageMock.replaceDocument).toHaveBeenCalledWith(3, 55, files);
    });

    it('delegates deleteDocument with the user and parsed id', () => {
      void controller.deleteDocument(makeRequest(3), 55);

      expect(storageMock.deleteDocument).toHaveBeenCalledWith(3, 55);
    });

    it('delegates getMyDocuments with the user and optional document type', () => {
      void controller.getMyDocuments(makeRequest(3), 'Form 138');

      expect(storageMock.getMyDocuments).toHaveBeenCalledWith(3, 'Form 138');
    });

    it('delegates getMyGradeReports with the authenticated user', () => {
      void controller.getMyGradeReports(makeRequest(3));

      expect(gradeReportsMock.getMyGradeReports).toHaveBeenCalledWith(3);
    });

    it('delegates getAllGradeReports with the query object', () => {
      const query = { status: 'FLAGGED' } as QueryGradeReportsDto;

      void controller.getAllGradeReports(query);

      expect(gradeReportsMock.getAllGradeReports).toHaveBeenCalledWith(query);
    });

    it('delegates updateGradeReportStatus with user, parsed id, and dto', () => {
      const dto = { status: 'APPROVED' } as UpdateGradeReportStatusDto;

      void controller.updateGradeReportStatus(makeRequest(3), 71, dto);

      expect(gradeReportsMock.updateGradeReportStatus).toHaveBeenCalledWith(
        3,
        71,
        dto,
      );
    });

    it('delegates submitAppeal with user, parsed id, and dto', () => {
      const dto = { appeal_notes: 'Medical emergency.' } as SubmitAppealDto;

      void controller.submitAppeal(makeRequest(3), 71, dto);

      expect(appealMock.submitAppeal).toHaveBeenCalledWith(3, 71, dto);
    });

    it('delegates reviewAppeal with user, parsed id, and dto', () => {
      const dto = { decision: 'APPROVED' } as ReviewAppealDto;

      void controller.reviewAppeal(makeRequest(3), 71, dto);

      expect(appealMock.reviewAppeal).toHaveBeenCalledWith(3, 71, dto);
    });

    it('delegates getPendingAppeals with no arguments', () => {
      void controller.getPendingAppeals();

      expect(appealMock.getPendingAppeals).toHaveBeenCalledWith();
    });

    it('delegates getExtractedData with the user, id, and role', () => {
      void controller.getExtractedData(makeRequest(3, Role.ADMIN), 55);

      expect(ocrMock.getExtractedData).toHaveBeenCalledWith(3, 55, 'ADMIN');
    });

    it('delegates confirmDocument with the user, id, and dto', () => {
      const dto = { general_average: 1.5 } as ConfirmDocumentDto;

      void controller.confirmDocument(makeRequest(3), 55, dto);

      expect(evaluationMock.confirmDocument).toHaveBeenCalledWith(3, 55, dto);
    });

    it('delegates getPendingDocuments with no arguments', () => {
      void controller.getPendingDocuments();

      expect(storageMock.getPendingDocuments).toHaveBeenCalledWith();
    });

    it('delegates getDocumentDetail with the parsed id', () => {
      void controller.getDocumentDetail(55);

      expect(storageMock.getDocumentDetail).toHaveBeenCalledWith(55);
    });

    it('delegates retryDocumentOcr with user, id, and caller role', () => {
      void controller.retryDocumentOcr(makeRequest(3, Role.COORDINATOR), 55);

      expect(ocrMock.retryDocumentOcr).toHaveBeenCalledWith(
        3,
        55,
        'COORDINATOR',
      );
    });

    it('delegates requestChanges with user, id, and the reason text', () => {
      const dto = { reason: 'Blurry scan' };

      void controller.requestChanges(makeRequest(3), 55, dto);

      expect(evaluationMock.requestChanges).toHaveBeenCalledWith(
        3,
        55,
        'Blurry scan',
      );
    });

    it('delegates verifyAndEvaluate with user, id, and dto', () => {
      const dto = { grade_items: [] } as VerifyDocumentDto;

      void controller.verifyAndEvaluate(makeRequest(3), 55, dto);

      expect(evaluationMock.verifyAndEvaluate).toHaveBeenCalledWith(3, 55, dto);
    });

    it('delegates staffVerifyDocument with user, id, and optional notes', () => {
      void controller.staffVerifyDocument(makeRequest(3), 55, {
        notes: 'Bypassed doc check',
      });

      expect(evaluationMock.staffVerifyDocument).toHaveBeenCalledWith(
        3,
        55,
        'Bypassed doc check',
      );
    });
  });

  describe('validateUploadedFiles', () => {
    const tenMb = 10 * 1024 * 1024;

    it('throws when no files are provided', () => {
      expect(
        () =>
          void controller.uploadDocument(
            makeRequest() as never,
            [] as Express.Multer.File[],
            'TOR',
          ),
      ).toThrow(new BadRequestException('At least one file must be provided.'));
    });

    it('accepts a file exactly at the 10 MB boundary', () => {
      const files = [makeFile(tenMb, 'ok.png', 'image/png')];

      void controller.uploadDocument(makeRequest(3), files, 'Form 138');

      expect(storageMock.uploadDocument).toHaveBeenCalled();
    });

    it('rejects a file one byte over the 10 MB boundary', () => {
      const files = [makeFile(tenMb + 1, 'big.png', 'image/png')];

      expect(
        () =>
          void controller.uploadDocument(
            makeRequest() as never,
            files,
            'Form 138',
          ),
      ).toThrow(
        new BadRequestException('File "big.png" exceeds the 10MB size limit.'),
      );
    });

    it('rejects an unsupported format by extension and mimetype', () => {
      const files = [makeFile(1024, 'envelope.txt', 'text/plain')];

      expect(
        () =>
          void controller.uploadDocument(makeRequest() as never, files, 'TOR'),
      ).toThrow(
        new BadRequestException(
          'File "envelope.txt" has an unsupported format. Allowed formats: JPG, PNG, WEBP, PDF.',
        ),
      );
    });

    it.each(['jpg', 'jpeg', 'png', 'webp', 'pdf'])(
      'accepts the allowed .%s extension',
      (extension) => {
        const files = [
          makeFile(1024, `card.${extension}`, `image/${extension}`),
        ];

        void controller.uploadDocument(makeRequest(3), files, 'TOR');

        expect(storageMock.uploadDocument).toHaveBeenCalled();
      },
    );

    it('accepts MIME type matching even when the extension is unknown', () => {
      const files = [makeFile(1024, 'weird.bin', 'application/pdf')];

      void controller.uploadDocument(makeRequest(3), files, 'TOR');

      expect(storageMock.uploadDocument).toHaveBeenCalled();
    });

    it('requires files for the replace endpoint too', () => {
      expect(
        () =>
          void controller.replaceDocument(
            makeRequest() as never,
            55,
            [] as Express.Multer.File[],
          ),
      ).toThrow(new BadRequestException('At least one file must be provided.'));
    });
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = DocumentsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('gates scholar document endpoints to applicants and scholars', () => {
      for (const name of [
        'getAllowedDocumentTypes',
        'uploadDocument',
        'replaceDocument',
        'deleteDocument',
        'getMyDocuments',
        'confirmDocument',
        'getMyGradeReports',
      ]) {
        const roles = rolesFor(handlerFor(name)) ?? [];
        expect(roles).toEqual(
          expect.arrayContaining([Role.APPLICANT, Role.SCHOLAR]),
        );
      }
    });

    it('gates staff endpoints to admin, grantor and coordinator', () => {
      for (const name of [
        'getAllGradeReports',
        'updateGradeReportStatus',
        'getPendingDocuments',
        'getDocumentDetail',
        'requestChanges',
        'verifyAndEvaluate',
        'staffVerifyDocument',
      ]) {
        const roles = rolesFor(handlerFor(name)) ?? [];
        expect(roles).toEqual(
          expect.arrayContaining([Role.ADMIN, Role.GRANTOR, Role.COORDINATOR]),
        );
      }
    });

    it('gates the appeal review endpoint to grantor and admin only', () => {
      expect(rolesFor(handlerFor('reviewAppeal'))).toEqual([
        Role.GRANTOR,
        Role.ADMIN,
      ]);
    });

    it('gates the submit-appeal endpoint to scholars only', () => {
      expect(rolesFor(handlerFor('submitAppeal'))).toEqual([Role.SCHOLAR]);
    });
  });
});
