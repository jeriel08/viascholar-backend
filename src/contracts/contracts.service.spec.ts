import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContractsService } from './contracts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PdfStamperService } from './services/pdf-stamper.service.js';
import { ContractSigningService } from './services/contract-signing.service.js';
import type { CreateContractDto } from './dto/create-contract.dto.js';
import type { SignContractOptions } from './services/contract-signing.service.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
  },
  contract: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({
  sendContractReadyToSign: vi.fn(),
});
const createCloudinaryMock = () => ({
  uploadBuffer: vi.fn(),
});
const createPdfStamperMock = () => ({
  generateUnsignedDraft: vi.fn(),
});
const createSigningMock = () => ({
  requestContractChanges: vi.fn(),
  signContract: vi.fn(),
});
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createNotificationsMock = () => ({
  notifyStaff: vi.fn(),
  notifyUser: vi.fn(),
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  phone_number: '09171234567',
  student_address: '123 Street',
  student_number: '202300123',
  school_name: 'University of Mindanao',
  school_address: 'Davao City',
  course_of_study: 'BSIT',
  scholarship_track: 'Academic Track',
  applications: [
    {
      application_id: 42,
      status: 'APPROVED',
      submitted_at: new Date('2026-06-01T00:00:00.000Z'),
    },
  ],
  user: { user_id: 7, email: 'juan@example.com', role: 'APPLICANT' },
  ...overrides,
});

const makeContract = (overrides: Record<string, unknown> = {}) => ({
  contract_id: 77,
  scholar_profile_id: 11,
  contract_number: 'CTX-001',
  status: 'PENDING',
  effective_date: new Date('2026-08-01T00:00:00.000Z'),
  expiry_date: new Date('2030-08-01T00:00:00.000Z'),
  ...overrides,
});

const createDto = {
  scholar_profile_id: 11,
  contract_number: 'CTX-001',
  effective_date: '2026-08-01T00:00:00.000Z',
} as CreateContractDto;

describe('ContractsService', () => {
  let service: ContractsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let cloudinary: ReturnType<typeof createCloudinaryMock>;
  let pdfStamper: ReturnType<typeof createPdfStamperMock>;
  let contractSigning: ReturnType<typeof createSigningMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();
    cloudinary = createCloudinaryMock();
    pdfStamper = createPdfStamperMock();
    contractSigning = createSigningMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholar());
    prisma.contract.create.mockResolvedValue(makeContract());
    prisma.contract.findMany.mockResolvedValue([makeContract()]);
    prisma.contract.findUnique.mockResolvedValue(
      makeContract({
        certificate_id: 'VIA-CERT-2026-ABCDEF12',
        status: 'SIGNED',
        signed_at: new Date('2026-09-01T00:00:00.000Z'),
        document_hash: 'd'.repeat(64),
        signed_document_url: 'https://cdn.test/signed.pdf',
        scholar_profile: {
          first_name: 'Juan',
          last_name: 'Dela Cruz',
          student_number: '202300123',
          school_name: 'University of Mindanao',
          scholarship_track: 'Academic Track',
        },
      }),
    );

    pdfStamper.generateUnsignedDraft.mockResolvedValue(
      Buffer.from('draft-pdf'),
    );
    cloudinary.uploadBuffer.mockResolvedValue({
      secure_url: 'https://cdn.test/draft.pdf',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: PdfStamperService, useValue: pdfStamper },
        { provide: ContractSigningService, useValue: contractSigning },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<ContractsService>(ContractsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('createContract', () => {
    it('throws NotFoundException when the scholar does not exist', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.createContract(7, createDto)).rejects.toThrow(
        new NotFoundException('Scholar profile ID 11 not found.'),
      );
    });

    it('throws BadRequestException when the latest application is not approved', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          applications: [
            {
              application_id: 42,
              status: 'UNDER_REVIEW',
              submitted_at: new Date('2026-06-01T00:00:00.000Z'),
            },
          ],
        }),
      );

      await expect(service.createContract(7, createDto)).rejects.toThrow(
        new BadRequestException(
          'A contract can only be created after the grantor has approved the latest application.',
        ),
      );
    });

    it('throws BadRequestException when the scholar has no application at all', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ applications: [] }),
      );

      await expect(service.createContract(7, createDto)).rejects.toThrow(
        new BadRequestException(
          'A contract can only be created after the grantor has approved the latest application.',
        ),
      );
    });

    it('creates the contract, uploads the draft, emails the student, and emits events', async () => {
      const result = await service.createContract(7, createDto);

      expect(pdfStamper.generateUnsignedDraft).toHaveBeenCalledWith(
        objectMatching({
          studentName: 'Juan Dela Cruz',
          studentEmail: 'juan@example.com',
          contractNumber: 'CTX-001',
        }),
      );
      expect(cloudinary.uploadBuffer).toHaveBeenCalledWith(
        Buffer.from('draft-pdf'),
        'viascholar/draft-contracts',
        stringMatching(/^draft_CTX-001_\d+$/),
        'auto',
      );
      expect(prisma.contract.create).toHaveBeenCalledWith({
        data: objectMatching({
          scholar_profile_id: 11,
          contract_number: 'CTX-001',
          status: 'PENDING',
          document_url: 'https://cdn.test/draft.pdf',
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'CONTRACT_CREATED',
        expect.stringContaining('CTX-001'),
      );
      expect(mail.sendContractReadyToSign).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ contractNumber: 'CTX-001' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'contract:created',
        objectMatching({ contractNumber: 'CTX-001' }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'contract:created',
        objectMatching({ contractNumber: 'CTX-001' }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Scholarship Agreement Ready' }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'Scholarship Agreement Ready' }),
      );
      expect(result).toEqual(makeContract());
    });

    it('builds a default 4-year expiry when none is provided', async () => {
      await service.createContract(7, createDto);

      expect(prisma.contract.create).toHaveBeenCalledWith({
        data: objectMatching({
          expiry_date: anyArg(Date),
        }),
      });
    });

    it('uses the provided expiry date when supplied', async () => {
      await service.createContract(7, {
        ...createDto,
        expiry_date: '2035-08-01T00:00:00.000Z',
      });

      expect(prisma.contract.create).toHaveBeenCalledWith({
        data: objectMatching({
          expiry_date: new Date('2035-08-01T00:00:00.000Z'),
        }),
      });
    });

    it('does not emit the user-specific event when the scholar has no user', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ user_id: null }),
      );

      await service.createContract(7, createDto);

      expect(events.emitToUser).not.toHaveBeenCalled();
      expect(notifications.notifyUser).not.toHaveBeenCalled();
    });

    it('does not send the student email when the student has no email', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ user: null }),
      );

      await service.createContract(7, createDto);

      expect(mail.sendContractReadyToSign).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns every contract when no status is provided', async () => {
      const result = await service.findAll();

      expect(prisma.contract.findMany).toHaveBeenCalledWith(
        objectMatching({ where: undefined }),
      );
      expect(result).toEqual([makeContract()]);
    });

    it('filters by status when provided', async () => {
      await service.findAll('SIGNED');

      expect(prisma.contract.findMany).toHaveBeenCalledWith(
        objectMatching({ where: { status: 'SIGNED' } }),
      );
    });
  });

  describe('getMyContracts', () => {
    it('throws NotFoundException when the scholar does not exist', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getMyContracts(7)).rejects.toThrow(
        new NotFoundException('Scholar profile not found.'),
      );
    });

    it("returns the scholar's contracts newest first", async () => {
      const result = await service.getMyContracts(7);

      expect(prisma.contract.findMany).toHaveBeenCalledWith({
        where: { scholar_profile_id: 11 },
        orderBy: { contract_id: 'desc' },
      });
      expect(result).toEqual([makeContract()]);
    });
  });

  describe('requestContractChanges', () => {
    it('delegates to the signing service', () => {
      const dto = { reason: 'Typo' };
      const expected = { message: 'Requested.' };
      contractSigning.requestContractChanges.mockReturnValue(expected);

      const result = service.requestContractChanges(7, 77, dto);

      expect(contractSigning.requestContractChanges).toHaveBeenCalledWith(
        7,
        77,
        dto,
      );
      expect(result).toBe(expected);
    });
  });

  describe('signContract', () => {
    it('delegates to the signing service with all options', () => {
      const options = {
        signatureBuffer: Buffer.from('x'),
        signerIp: '1.2.3.4',
        signerUserAgent: 'Agent',
      } as SignContractOptions;
      const expected = { status: 'SIGNED' };
      contractSigning.signContract.mockReturnValue(expected);

      const result = service.signContract(7, 77, options);

      expect(contractSigning.signContract).toHaveBeenCalledWith(7, 77, options);
      expect(result).toBe(expected);
    });
  });

  describe('verifyContract', () => {
    it('throws NotFoundException when the certificate is unknown', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyContract('VIA-CERT-2026-FFFFFFFF'),
      ).rejects.toThrow(
        new NotFoundException(
          "Contract certificate 'VIA-CERT-2026-FFFFFFFF' was not found or is invalid.",
        ),
      );
    });

    it('returns the signed contract details when the certificate is valid', async () => {
      const result = await service.verifyContract('VIA-CERT-2026-ABCDEF12');

      expect(result).toEqual({
        valid: true,
        certificate_id: 'VIA-CERT-2026-ABCDEF12',
        contract_number: 'CTX-001',
        status: 'SIGNED',
        student_name: 'Juan Dela Cruz',
        student_number: '202300123',
        school_name: 'University of Mindanao',
        scholarship_track: 'Academic Track',
        effective_date: anyArg(Date),
        signed_at: anyArg(Date),
        document_hash: 'd'.repeat(64),
        signed_document_url: 'https://cdn.test/signed.pdf',
      });
    });

    it('returns valid=false when the contract is not yet signed', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({
          certificate_id: 'VIA-CERT-2026-ABCDEF12',
          status: 'PENDING',
          scholar_profile: {
            first_name: 'Ana',
            last_name: 'Santos',
            student_number: null,
            school_name: null,
            scholarship_track: null,
          },
        }),
      );

      const result = await service.verifyContract('VIA-CERT-2026-ABCDEF12');

      expect(result.valid).toBe(false);
      expect(result.student_number).toBe('N/A');
      expect(result.school_name).toBe('N/A');
      expect(result.scholarship_track).toBe('General');
    });
  });
});
