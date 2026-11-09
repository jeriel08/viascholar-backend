import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ForbiddenException,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DocumentOcrService } from './document-ocr.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { LlamaExtractService } from '../extractors/llama-extract.service.js';
import { DocumentReconciliationService } from './document-reconciliation.service.js';
import { DocumentSchoolLinkerService } from './document-school-linker.service.js';
import { ParseurSyncService } from './parseur-sync.service.js';
import { DocumentDataQueryService } from './document-data-query.service.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;

const createPrismaMock = () => ({
  scholarDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
});
const createLlamaMock = () => ({ extractData: vi.fn() });
const createReconciliationMock = () => ({
  evaluateExtractedDocument: vi.fn().mockReturnValue({
    is_flagged: false,
    risk_level: 'LOW',
    flags: [],
    summary: 'ok',
  }),
});
const createSchoolLinkerMock = () => ({
  linkSchoolGradingSystem: vi.fn().mockResolvedValue(undefined),
});
const createParseurSyncMock = () => ({
  sendToParseur: vi.fn(),
  syncFromParseur: vi.fn(),
});
const createDataQueryMock = () => ({ getExtractedData: vi.fn() });
const createConfigMock = (provider?: string) => ({
  get: vi
    .fn()
    .mockImplementation((key: string) =>
      key === 'OCR_PROVIDER' ? (provider ?? 'llama-extract') : null,
    ),
});

const makeDoc = (overrides: Record<string, unknown> = {}) => ({
  document_id: 55,
  scholar_profile_id: 11,
  document_type: 'Form 138',
  label: 'Senior High School Report Card (Form 138 / Form 9)',
  status: 'PENDING',
  file_url: 'https://cdn.test/doc.pdf',
  file_name: 'form138.pdf',
  file_type: 'pdf',
  extracted_data: {
    forensic_metadata: { is_flagged: false, detected_software: [], flags: [] },
  },
  scholar_profile: {
    profile_id: 11,
    user_id: 7,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    current_year_level: 1,
    school_name: 'University of Mindanao',
    school_id: 3,
  },
  ...overrides,
});

const makeExtracted = (overrides: Record<string, unknown> = {}) => ({
  detected_document_type: 'FORM_138',
  student_name: 'Juan Dela Cruz',
  grades: [
    {
      subject_code: 'Math 10',
      subject_name: 'Mathematics',
      units: 1,
      grade: 90,
    },
  ],
  has_signature: true,
  ...overrides,
});

describe('DocumentOcrService', () => {
  let service: DocumentOcrService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;
  let llama: ReturnType<typeof createLlamaMock>;
  let reconciliation: ReturnType<typeof createReconciliationMock>;
  let schoolLinker: ReturnType<typeof createSchoolLinkerMock>;
  let parseurSync: ReturnType<typeof createParseurSyncMock>;
  let dataQuery: ReturnType<typeof createDataQueryMock>;

  const build = async (provider?: string) => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();
    llama = createLlamaMock();
    reconciliation = createReconciliationMock();
    schoolLinker = createSchoolLinkerMock();
    parseurSync = createParseurSyncMock();
    dataQuery = createDataQueryMock();

    prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());
    prisma.scholarDocument.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeDoc(), ...data }),
    );
    llama.extractData.mockResolvedValue(makeExtracted());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentOcrService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: createConfigMock(provider) },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: LlamaExtractService, useValue: llama },
        { provide: DocumentReconciliationService, useValue: reconciliation },
        { provide: DocumentSchoolLinkerService, useValue: schoolLinker },
        { provide: ParseurSyncService, useValue: parseurSync },
        { provide: DocumentDataQueryService, useValue: dataQuery },
      ],
    }).compile();

    service = module.get<DocumentOcrService>(DocumentOcrService);
  };

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await build();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('processDocumentExtraction', () => {
    it('routes to the Parseur provider without touching the database', async () => {
      await build('parseur');

      const result = await service.processDocumentExtraction(
        55,
        Buffer.from('pdf'),
        'doc.pdf',
        'application/pdf',
      );

      expect(parseurSync.sendToParseur).toHaveBeenCalledWith(
        55,
        expect.any(Buffer),
        'doc.pdf',
        'application/pdf',
      );
      expect(llama.extractData).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('throws NotFoundException when the document does not exist', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(
        service.processDocumentExtraction(
          55,
          Buffer.from('x'),
          'f.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow(new NotFoundException('Document ID 55 not found.'));
    });

    it('passes the forensic metadata through to the reconciliation service', async () => {
      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
        'TOR',
      );

      expect(reconciliation.evaluateExtractedDocument).toHaveBeenCalledWith(
        expect.objectContaining({ profile_id: 11 }),
        'Form 138',
        anyArg(Object),
        { is_flagged: false, detected_software: [], flags: [] },
      );
    });

    it('marks a readable FORM_138 with grades as PASSED_PRECHECK', async () => {
      const result = (await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      )) as unknown as { processed: boolean; provider: string; status: string };

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith(
        objectMatching({
          where: { document_id: 55 },
          data: objectMatching({
            status: 'PASSED_PRECHECK',
            document_type: 'Form 138 / Form 9',
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_OCR_PROCESSED',
        expect.stringContaining('PASSED_PRECHECK'),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'document:ocr_completed',
        objectMatching({ status: 'PASSED_PRECHECK', hasGrades: true }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'document:ocr_completed',
        objectMatching({ status: 'PASSED_PRECHECK' }),
      );
      expect(result.processed).toBe(true);
      expect(result.provider).toBe('llama-extract');
    });

    it('links the school grading system from the extracted school name', async () => {
      llama.extractData.mockResolvedValue(
        makeExtracted({
          school_name: 'University of Mindanao',
          grading_legend: { notes: 'x' },
        }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      expect(schoolLinker.linkSchoolGradingSystem).toHaveBeenCalledWith(
        11,
        7,
        'University of Mindanao',
        { notes: 'x' },
        'University of Mindanao',
      );
    });

    it('skips linking when the document has no scholar profile id', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ scholar_profile_id: null, scholar_profile: undefined }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      expect(schoolLinker.linkSchoolGradingSystem).not.toHaveBeenCalled();
    });

    it('rejects a CCG when a Statement of Account was uploaded', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG', document_type_detected: undefined }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'STATEMENT_OF_ACCOUNT' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'ccg.pdf',
        'application/pdf',
        'CCG',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string };
      };
      expect(updateCall.data.status).toBe('NEEDS_REUPLOAD');
      expect(updateCall.data.rejection_reason).toContain(
        'Statement of Account / Tuition Assessment',
      );
    });

    it('rejects a CCG when a Certificate of Registration was uploaded', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({
          detected_document_type: 'CERTIFICATE_OF_REGISTRATION',
        }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'ccg.pdf',
        'application/pdf',
        'CCG',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string };
      };
      expect(updateCall.data.status).toBe('NEEDS_REUPLOAD');
      expect(updateCall.data.rejection_reason).toContain(
        'Certificate of Registration (COR)',
      );
    });

    it('rejects a CCG when a transcript was uploaded', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'TRANSCRIPT_OF_RECORDS' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'ccg.pdf',
        'application/pdf',
        'CCG',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'A Transcript of Records (TOR) is prohibited for semestral grade audits.',
      );
    });

    it('rejects a CCG when a Form 138 was uploaded', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'FORM_138' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'ccg.pdf',
        'application/pdf',
        'CCG',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'A High School Report Card (Form 138 / SF9) is prohibited',
      );
    });

    it('rejects an unrecognized CCG document', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'OTHER' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'ccg.pdf',
        'application/pdf',
        'CCG',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'Unsupported document',
      );
    });

    it('rejects a CCG when no registrar signature is detected', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({
          detected_document_type: 'CERTIFICATE_OF_GRADES',
          has_signature: false,
        }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'ccg.pdf',
        'application/pdf',
        'CCG',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'Uncertified grade slip',
      );
    });

    it('flags a Form 138 for a Year 2+ upperclassman', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          document_type: 'TOR',
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            current_year_level: 3,
            school_name: 'University of Mindanao',
          },
        }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'FORM_138' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'tor.pdf',
        'application/pdf',
        'TOR',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string };
      };
      expect(updateCall.data.status).toBe('NEEDS_REUPLOAD');
      expect(updateCall.data.rejection_reason).toContain('Year 3 student');
    });

    it('flags a Certificate of Grades for a Year 2+ upperclassman', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          document_type: 'TOR',
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            current_year_level: 2,
            school_name: 'University of Mindanao',
          },
        }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'CERTIFICATE_OF_GRADES' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'tor.pdf',
        'application/pdf',
        'TOR',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'Certificate of Grades / Grade Slip',
      );
    });

    it('flags a TOR for a 1st-year applicant', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          document_type: 'Form 138',
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            current_year_level: 1,
            school_name: 'UM',
          },
        }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'TRANSCRIPT_OF_RECORDS' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'College Transcript of Records (TOR)',
      );
    });

    it('flags an unsupported STATEMENT_OF_ACCOUNT for a 1st-year applicant', async () => {
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'STATEMENT_OF_ACCOUNT' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { rejection_reason: string };
      };
      expect(updateCall.data.rejection_reason).toContain(
        'not an official grade report or transcript',
      );
    });

    it('flags a missing student name on the document', async () => {
      llama.extractData.mockResolvedValue(
        makeExtracted({ student_name: undefined }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string };
      };
      expect(updateCall.data.status).toBe('NEEDS_REUPLOAD');
      expect(updateCall.data.rejection_reason).toContain(
        'Applicant name not detected',
      );
    });

    it('flags a document without readable grades as NEEDS_REUPLOAD', async () => {
      llama.extractData.mockResolvedValue(makeExtracted({ grades: [] }));

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string };
      };
      expect(updateCall.data.status).toBe('NEEDS_REUPLOAD');
      expect(updateCall.data.rejection_reason).toContain(
        'No course grades detected',
      );
    });

    it('humanizes the detected type on update for TOR documents', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          document_type: 'TOR',
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            current_year_level: 2,
            school_name: 'University of Mindanao',
          },
        }),
      );
      llama.extractData.mockResolvedValue(
        makeExtracted({ detected_document_type: 'TRANSCRIPT_OF_RECORDS' }),
      );

      await service.processDocumentExtraction(
        55,
        Buffer.from('x'),
        'tor.pdf',
        'application/pdf',
        'TOR',
      );

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            document_type: 'TOR',
            label: 'College Transcript of Records (TOR)',
          }),
        }),
      );
    });

    it('records the OCR failure and marks the document NEEDS_REUPLOAD when extraction crashes', async () => {
      llama.extractData.mockRejectedValue(new Error('llama exploded'));

      await expect(
        service.processDocumentExtraction(
          55,
          Buffer.from('x'),
          'f.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow('llama exploded');

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 55 },
        data: {
          status: 'NEEDS_REUPLOAD',
          rejection_reason:
            'AI analysis was unable to extract grades from this file. You can retry AI Analysis, replace the file, or enter grades manually.',
        },
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'document:ocr_completed',
        objectMatching({ errorMessage: expect.any(String) as string }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'document:ocr_completed',
        objectMatching({ status: 'NEEDS_REUPLOAD' }),
      );
    });

    it('does not downgrade the status when the document was already verified', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ status: 'VERIFIED' }),
      );
      llama.extractData.mockRejectedValue(new Error('llama exploded'));

      await expect(
        service.processDocumentExtraction(
          55,
          Buffer.from('x'),
          'f.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow('llama exploded');

      expect(prisma.scholarDocument.update).not.toHaveBeenCalled();
    });
  });

  describe('retryDocumentOcr', () => {
    it('throws NotFoundException when the document does not exist', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(service.retryDocumentOcr(7, 55, 'SCHOLAR')).rejects.toThrow(
        new NotFoundException('Document ID 55 not found.'),
      );
    });

    it('throws ForbiddenException for non-owner non-staff callers', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          scholar_profile: { profile_id: 11, user_id: 99, first_name: 'Other' },
        }),
      );

      await expect(
        service.retryDocumentOcr(7, 55, 'APPLICANT'),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to retry OCR on this document.',
        ),
      );
    });

    it("allows staff to retry someone else's document", async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ scholar_profile: { profile_id: 11, user_id: 99 } }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: () => Promise.resolve(Buffer.from('pdf').buffer),
        }),
      );

      const result = (await service.retryDocumentOcr(
        7,
        55,
        'COORDINATOR',
      )) as unknown as { processed: boolean };

      expect(result.processed).toBe(true);
      vi.unstubAllGlobals();
    });

    it('throws BadRequestException for verified documents', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ status: 'VERIFIED' }),
      );

      await expect(service.retryDocumentOcr(7, 55, 'SCHOLAR')).rejects.toThrow(
        new BadRequestException('Verified documents cannot be re-extracted.'),
      );
    });

    it('throws BadRequestException when the document has no file URL', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ file_url: null }),
      );

      await expect(service.retryDocumentOcr(7, 55, 'SCHOLAR')).rejects.toThrow(
        new BadRequestException(
          'Document has no valid file URL to re-process.',
        ),
      );
    });

    it('resets the status to PENDING, emits the pending payload, and reprocesses the file', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: () => Promise.resolve(Buffer.from('pdf-bytes').buffer),
        }),
      );

      await service.retryDocumentOcr(7, 55, 'SCHOLAR');

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 55 },
        data: { status: 'PENDING', rejection_reason: null },
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'document:ocr_completed',
        objectMatching({ status: 'PENDING' }),
      );
      expect(llama.extractData).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('throws BadRequestException when the stored file cannot be downloaded', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      );

      await expect(service.retryDocumentOcr(7, 55, 'SCHOLAR')).rejects.toThrow(
        new BadRequestException(
          'Failed to download stored file from storage (403).',
        ),
      );
      vi.unstubAllGlobals();
    });
  });

  describe('delegations', () => {
    it('delegates getExtractedData to the data query service', () => {
      void service.getExtractedData(7, 55, 'SCHOLAR');

      expect(dataQuery.getExtractedData).toHaveBeenCalledWith(7, 55, 'SCHOLAR');
    });

    it('delegates sendToParseur to the parseur service', () => {
      void service.sendToParseur(
        55,
        Buffer.from('x'),
        'f.pdf',
        'application/pdf',
      );

      expect(parseurSync.sendToParseur).toHaveBeenCalledWith(
        55,
        expect.any(Buffer),
        'f.pdf',
        'application/pdf',
      );
    });

    it('delegates syncFromParseur to the parseur service', () => {
      void service.syncFromParseur(7, 55);

      expect(parseurSync.syncFromParseur).toHaveBeenCalledWith(7, 55);
    });
  });
});
