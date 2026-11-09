import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ParseurSyncService } from './parseur-sync.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { DocumentReconciliationService } from './document-reconciliation.service.js';

const okJson = (body: unknown) => () => Promise.resolve(body);
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createReconciliationMock = () => ({
  evaluateExtractedDocument: vi.fn().mockReturnValue({
    is_flagged: false,
    risk_level: 'LOW',
    flags: [],
    summary: 'ok',
  }),
});

const makeDoc = (overrides: Record<string, unknown> = {}) => ({
  document_id: 55,
  scholar_profile_id: 11,
  document_type: 'Form 138',
  status: 'PENDING',
  parseur_doc_id: 'pd-123',
  extracted_data: null,
  scholar_profile: {
    profile_id: 11,
    user_id: 7,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
  },
  ...overrides,
});

const createConfigMock = (
  apiKey?: string | null,
  mailboxId?: string | null,
) => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'PARSEUR_API_KEY')
      return apiKey === undefined ? 'test-parseur-key' : (apiKey ?? undefined);
    if (key === 'PARSEUR_MAILBOX_ID')
      return mailboxId === undefined ? 'mb-77' : (mailboxId ?? undefined);
    return undefined;
  }),
});

describe('ParseurSyncService', () => {
  let service: ParseurSyncService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;
  let reconciliation: ReturnType<typeof createReconciliationMock>;

  const build = async (apiKey?: string | null, mailboxId?: string | null) => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();
    reconciliation = createReconciliationMock();

    prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());
    prisma.scholarDocument.update.mockResolvedValue(makeDoc());
    prisma.user.findUnique.mockResolvedValue({ role: 'SCHOLAR' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParseurSyncService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: createConfigMock(apiKey, mailboxId),
        },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        {
          provide: DocumentReconciliationService,
          useValue: reconciliation,
        },
      ],
    }).compile();

    service = module.get<ParseurSyncService>(ParseurSyncService);
  };

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await build();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('sendToParseur', () => {
    it('warns and returns null when credentials are missing', async () => {
      await build(null, null);

      const result = await service.sendToParseur(
        55,
        Buffer.from('pdf'),
        'doc.pdf',
        'application/pdf',
      );

      expect(result).toBeNull();
      expect(prisma.scholarDocument.update).not.toHaveBeenCalled();
    });

    it('uploads the buffer and stores the Parseur document id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({ attachments: [{ DocumentID: 98765 }] }),
        }),
      );

      await service.sendToParseur(
        55,
        Buffer.from('pdf'),
        'doc.pdf',
        'application/pdf',
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.parseur.com/parser/mb-77/upload',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Token test-parseur-key' },
        }),
      );
      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 55 },
        data: { parseur_doc_id: '98765' },
      });
    });

    it('throws when the Parseur API responds with an error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          text: () => Promise.resolve('bad gateway'),
        }),
      );

      await expect(
        service.sendToParseur(
          55,
          Buffer.from('pdf'),
          'doc.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow('Parseur API responded with status 502: bad gateway');
    });
  });

  describe('syncFromParseur', () => {
    it('throws NotFoundException when the document does not exist', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(service.syncFromParseur(7, 55)).rejects.toThrow(
        new NotFoundException('Document ID 55 not found.'),
      );
    });

    it('throws ForbiddenException for non-owner non-staff callers', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ scholar_profile: { profile_id: 11, user_id: 99 } }),
      );

      await expect(service.syncFromParseur(7, 55)).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to sync this document.',
        ),
      );
    });

    it("allows staff to sync anyone's document", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'COORDINATOR' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({
            status: 'PARSEDOK',
            result: JSON.stringify({
              student_name: 'Juan Dela Cruz',
              grades: [{ subject_code: 'A', grade: 90 }],
            }),
          }),
        }),
      );

      const result = await service.syncFromParseur(42, 55);

      expect(result.synced).toBe(true);
    });

    it('throws BadRequestException when the document was never dispatched to Parseur', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ parseur_doc_id: null }),
      );

      await expect(service.syncFromParseur(7, 55)).rejects.toThrow(
        new BadRequestException(
          'Document ID 55 was never dispatched to Parseur.',
        ),
      );
    });

    it('throws BadRequestException when the API key is not configured', async () => {
      await build(null, 'mb-77');
      prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());

      await expect(service.syncFromParseur(7, 55)).rejects.toThrow(
        new BadRequestException('PARSEUR_API_KEY is not configured.'),
      );
    });

    it('throws BadRequestException when the Parseur API fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(service.syncFromParseur(7, 55)).rejects.toThrow(
        new BadRequestException(
          'Parseur API responded with status 500 for document pd-123.',
        ),
      );
    });

    it('reports not-synced when Parseur has not finished processing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({ status: 'PROCESSING' }),
        }),
      );

      const result = await service.syncFromParseur(7, 55);

      expect(result).toEqual({
        synced: false,
        message:
          'Parseur has not finished processing this document (status: PROCESSING).',
      });
    });

    it('reports not-synced when the parsable result is missing entirely', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({ status: 'PARSEDOK', result: 'not json at all' }),
        }),
      );

      const result = await service.syncFromParseur(7, 55);

      expect(result).toEqual({
        synced: false,
        message:
          'Parseur reported the document as processed but returned no parsable result.',
      });
    });

    it('accepts a parsed object result with nested fields', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({
            status: 'PARSEDOK',
            result: {
              fields: {
                student_name: 'Juan Dela Cruz',
                grades: [{ subject_code: 'A', grade: 90 }],
              },
            },
          }),
        }),
      );

      const result = await service.syncFromParseur(7, 55);

      expect(result.synced).toBe(true);
      expect(reconciliation.evaluateExtractedDocument).toHaveBeenCalledWith(
        expect.objectContaining({ profile_id: 11 }),
        'Form 138',
        expect.objectContaining({ grades: expect.any(Array) as unknown[] }),
        undefined,
      );
    });

    it('marks PASSED_PRECHECK when grades are present and the name matches', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({
            status: 'PARSEDOK',
            result: JSON.stringify({
              student_name: 'Juan Dela Cruz',
              grades: [{ subject_code: 'A', grade: 90 }],
            }),
          }),
        }),
      );

      await service.syncFromParseur(7, 55);

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({
            status: 'PASSED_PRECHECK',
            rejection_reason: null,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_SYNCED',
        expect.stringContaining('PASSED_PRECHECK'),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'document:ocr_completed',
        objectMatching({ hasGrades: true }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'document:ocr_completed',
        objectMatching({ hasGrades: true }),
      );
    });

    it('marks NEEDS_REUPLOAD with a name mismatch when the extracted name is wrong', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({
            status: 'PARSEDOK',
            result: JSON.stringify({
              student_name: 'Completely Unrelated Person',
              grades: [{ subject_code: 'A', grade: 90 }],
            }),
          }),
        }),
      );

      await service.syncFromParseur(7, 55);

      const call = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string | null };
      };
      expect(call.data.status).toBe('NEEDS_REUPLOAD');
      expect(call.data.rejection_reason).toContain('Name mismatch');
    });

    it('marks NEEDS_REUPLOAD with the generic reason when no grades were read', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: okJson({
            status: 'PARSEDOK',
            result: JSON.stringify({ student_name: 'Juan Dela Cruz' }),
          }),
        }),
      );

      await service.syncFromParseur(7, 55);

      const call = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; rejection_reason: string | null };
      };
      expect(call.data.status).toBe('NEEDS_REUPLOAD');
      expect(call.data.rejection_reason).toBe(
        'Unreadable document or missing grade records.',
      );
    });
  });
});
