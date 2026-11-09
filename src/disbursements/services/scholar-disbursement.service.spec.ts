import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ScholarDisbursementService } from './scholar-disbursement.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { LlamaExtractService } from '../../documents/extractors/llama-extract.service.js';
import type { SubmitOfficialReceiptDto } from '../dto/disbursement.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
  },
  disbursement: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  scholarDocument: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createCloudinaryMock = () => ({ uploadDocument: vi.fn() });
const createLlamaMock = () => ({ extractOfficialReceiptData: vi.fn() });

const makeScholarProfile = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  school_name: 'University of Mindanao',
  ...overrides,
});

const makeDisbursement = (overrides: Record<string, unknown> = {}) => ({
  disbursement_id: 55,
  scholar_profile_id: 11,
  status: 'CHECK_ISSUED',
  amount: '12500.00',
  academic_year: '2026-2027',
  semester: '1st Semester',
  date_claimed: null,
  remarks: null,
  ...overrides,
});

const makeSubmitDto = (
  overrides: Record<string, unknown> = {},
): SubmitOfficialReceiptDto => ({
  or_number: ' OR-12345 ',
  or_payment_date: '2026-09-01',
  file_url: 'https://cdn.test/or.png',
  file_name: 'or.png',
  ...overrides,
});

const makeFile = (
  sizeBytes: number,
  mimetype = 'image/png',
): Express.Multer.File =>
  ({
    originalname: 'receipt.png',
    mimetype,
    size: sizeBytes,
    buffer: Buffer.from('img'),
  }) as Express.Multer.File;

describe('ScholarDisbursementService', () => {
  let service: ScholarDisbursementService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;
  let cloudinary: ReturnType<typeof createCloudinaryMock>;
  let llama: ReturnType<typeof createLlamaMock>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();
    cloudinary = createCloudinaryMock();
    llama = createLlamaMock();

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholarProfile());
    prisma.disbursement.findMany.mockResolvedValue([]);
    prisma.disbursement.findUnique.mockResolvedValue(makeDisbursement());
    prisma.disbursement.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        makeDisbursement({
          ...data,
          scholar_profile: makeScholarProfile(),
          amount: '12500.00',
          or_document: { document_id: 999, status: 'PENDING' },
        }),
    );
    prisma.scholarDocument.create.mockResolvedValue({ document_id: 999 });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          scholarDocument: prisma.scholarDocument,
          disbursement: prisma.disbursement,
        }),
    );
    cloudinary.uploadDocument.mockResolvedValue({
      secure_url: 'https://cdn.test/or.png',
    });
    llama.extractOfficialReceiptData.mockResolvedValue({
      or_number: 'OR-12345',
      amount_paid: 12500,
      academic_year: '2026-2027',
      semester: '1st Semester',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScholarDisbursementService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: LlamaExtractService, useValue: llama },
      ],
    }).compile();

    service = module.get<ScholarDisbursementService>(
      ScholarDisbursementService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getMyDisbursements', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getMyDisbursements(7)).rejects.toThrow(
        new NotFoundException('Scholar profile not found.'),
      );
    });

    it('returns disbursements newest first with the OR and term documents', async () => {
      const rows = [makeDisbursement({ disbursement_id: 1 })];
      prisma.disbursement.findMany.mockResolvedValue(rows);

      const result = await service.getMyDisbursements(7);

      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { scholar_profile_id: 11 },
          orderBy: { created_at: 'desc' },
          include: objectMatching({
            or_document: true,
            term_enrollment: objectMatching({
              include: objectMatching({
                cor_document: true,
                soa_document: true,
              }),
            }),
          }),
        }),
      );
      expect(result).toBe(rows);
    });
  });

  describe('uploadAndScanReceipt', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadAndScanReceipt(7, [makeFile(1024)]),
      ).rejects.toThrow(new NotFoundException('Scholar profile not found.'));
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(service.uploadAndScanReceipt(7, [])).rejects.toThrow(
        new BadRequestException('No receipt file provided.'),
      );
    });

    it('rejects disallowed MIME types', async () => {
      await expect(
        service.uploadAndScanReceipt(7, [makeFile(1024, 'text/plain')]),
      ).rejects.toThrow(
        new BadRequestException(
          'Invalid file type. Please upload a JPG, PNG, WEBP, or PDF of your Official Receipt.',
        ),
      );
    });

    it('accepts a file exactly at the 15 MB boundary', async () => {
      const exact = makeFile(15 * 1024 * 1024, 'application/pdf');

      const result = await service.uploadAndScanReceipt(7, [exact]);

      expect(cloudinary.uploadDocument).toHaveBeenCalled();
      expect(result.file_name).toBe('receipt.png');
    });

    it('rejects a file one byte over the 15 MB boundary', async () => {
      await expect(
        service.uploadAndScanReceipt(7, [makeFile(15 * 1024 * 1024 + 1)]),
      ).rejects.toThrow(
        new BadRequestException('File size must not exceed 15MB.'),
      );
    });

    it('uploads the file then returns the cloudinary URL and OCR data', async () => {
      const result = await service.uploadAndScanReceipt(7, [makeFile(512)]);

      expect(cloudinary.uploadDocument).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'receipt.png' }),
        'viascholar/disbursements/receipts',
      );
      expect(llama.extractOfficialReceiptData).toHaveBeenCalledWith({
        buffer: anyArg(Buffer),
        fileName: 'receipt.png',
        mimeType: 'image/png',
      });
      expect(result).toEqual({
        file_url: 'https://cdn.test/or.png',
        file_name: 'receipt.png',
        file_size: '0.5 KB',
        extracted_data: objectMatching({ or_number: 'OR-12345' }),
      });
    });

    it('swallows OCR failures and returns a null extracted_data payload', async () => {
      llama.extractOfficialReceiptData.mockRejectedValue(
        new Error('llama timeout'),
      );

      const result = await service.uploadAndScanReceipt(7, [makeFile(512)]);

      expect(result.extracted_data).toBeNull();
      expect(result.file_url).toBe('https://cdn.test/or.png');
    });
  });

  describe('submitOfficialReceipt', () => {
    it('throws NotFoundException when the disbursement does not exist', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(null);

      await expect(
        service.submitOfficialReceipt(7, 999, makeSubmitDto()),
      ).rejects.toThrow(new NotFoundException('Disbursement #999 not found.'));
    });

    it('throws BadRequestException when the disbursement belongs to another scholar', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({ scholar_profile_id: 99 }),
      );

      await expect(
        service.submitOfficialReceipt(7, 55, makeSubmitDto()),
      ).rejects.toThrow(
        new BadRequestException(
          'You are not authorized to submit receipt for this disbursement.',
        ),
      );
    });

    it.each(['SETTLED', 'CANCELLED', 'OR_VERIFIED'])(
      'throws BadRequestException in the non-submittable "%s" status',
      async (status) => {
        prisma.disbursement.findUnique.mockResolvedValue(
          makeDisbursement({ status }),
        );

        await expect(
          service.submitOfficialReceipt(7, 55, makeSubmitDto()),
        ).rejects.toThrow(
          new BadRequestException(
            `Cannot submit Official Receipt when disbursement status is "${status}".`,
          ),
        );
      },
    );

    it.each(['CHECK_ISSUED', 'OR_SUBMITTED', 'AUTHORIZED', 'RELEASED'])(
      'accepts submissions in the "%s" status',
      async (status) => {
        prisma.disbursement.findUnique.mockResolvedValue(
          makeDisbursement({ status }),
        );

        const result = await service.submitOfficialReceipt(
          7,
          55,
          makeSubmitDto(),
        );

        expect(result.message).toBe(
          'Official Receipt successfully submitted for coordinator verification.',
        );
      },
    );

    it('audits and rejects when or_amount does not match the disbursed amount', async () => {
      await expect(
        service.submitOfficialReceipt(
          7,
          55,
          makeSubmitDto({ or_amount: 12000 }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'REJECT_OFFICIAL_RECEIPT_SUBMISSION',
        stringMatching(/12000/),
      );
    });

    it('validates the amount against extracted_data.amount_paid when or_amount is absent', async () => {
      await expect(
        service.submitOfficialReceipt(
          7,
          55,
          makeSubmitDto({
            extracted_data: { amount_paid: 13000 },
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('performs the submission when the extracted amount matches exactly', async () => {
      const result = await service.submitOfficialReceipt(
        7,
        55,
        makeSubmitDto({
          extracted_data: { amount_paid: 12500 },
        }),
      );

      expect(result.message).toContain('successfully submitted');
    });

    it('audits and rejects when the scanned school year does not match', async () => {
      await expect(
        service.submitOfficialReceipt(
          7,
          55,
          makeSubmitDto({
            extracted_data: { academic_year: '2025-2026' },
          }),
        ),
      ).rejects.toThrow('School Year');

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'REJECT_OFFICIAL_RECEIPT_SUBMISSION',
        stringMatching(/term mismatch/),
      );
    });

    it('rejects when the scanned semester does not match', async () => {
      await expect(
        service.submitOfficialReceipt(
          7,
          55,
          makeSubmitDto({
            extracted_data: { semester: 'Second Semester' },
          }),
        ),
      ).rejects.toThrow('Semester');
    });

    it('normalizes trivial format differences between scanned and expected terms', async () => {
      // 'AY 26-27' must normalize to '2026-2027', and 'midyear' to 'Summer'
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({
          academic_year: 'A.Y. 2026-2027',
          semester: 'Summer',
        }),
      );

      const result = await service.submitOfficialReceipt(
        7,
        55,
        makeSubmitDto({
          extracted_data: { academic_year: 'AY 26-27', semester: 'Midyear' },
        }),
      );

      expect(result.message).toContain('successfully submitted');
    });

    it('creates the OFFICIAL_RECEIPT document and marks the disbursement OR_SUBMITTED', async () => {
      await service.submitOfficialReceipt(
        7,
        55,
        makeSubmitDto({ remarks: 'OTC payment' }),
      );

      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: objectMatching({
          scholar_profile_id: 11,
          document_type: 'OFFICIAL_RECEIPT',
          status: 'PENDING',
          file_url: 'https://cdn.test/or.png',
        }),
      });
      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: {
          status: string;
          or_number: string;
          date_claimed: Date;
          remarks: string | null;
        };
      };
      expect(updateCall.data.status).toBe('OR_SUBMITTED');
      expect(updateCall.data.or_number).toBe('OR-12345');
      expect(updateCall.data.date_claimed).toBeInstanceOf(Date);
      expect(updateCall.data.remarks).toContain(
        'Scholar OR Submission: OTC payment',
      );

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'SUBMIT_OFFICIAL_RECEIPT',
        stringMatching(/OR-12345/),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'disbursement:or_submitted',
        objectMatching({ disbursement_id: 55, or_number: ' OR-12345 ' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'disbursement:updated',
        objectMatching({ status: 'OR_SUBMITTED' }),
      );
    });

    it('keeps the existing remarks when none are supplied and keeps the existing date_claimed', async () => {
      prisma.disbursement.findUnique.mockResolvedValue(
        makeDisbursement({
          remarks: 'Existing note',
          date_claimed: new Date('2026-08-01T00:00:00.000Z'),
        }),
      );

      await service.submitOfficialReceipt(7, 55, makeSubmitDto());

      const updateCall = prisma.disbursement.update.mock.calls[0][0] as {
        data: { remarks: string | null; date_claimed: Date };
      };
      expect(updateCall.data.remarks).toBe('Existing note');
      expect(updateCall.data.date_claimed).toEqual(
        new Date('2026-08-01T00:00:00.000Z'),
      );
    });
  });
});
