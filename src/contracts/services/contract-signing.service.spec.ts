import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContractSigningService } from './contract-signing.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PdfStamperService } from './pdf-stamper.service.js';
import { ConfigService } from '@nestjs/config';
import { Role } from '../../generated/prisma/enums.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;

const createPrismaMock = () => ({
  contract: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: {
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
});

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({
  getStaffEmails: vi.fn().mockResolvedValue([]),
  sendContractChangeRequestToStaff: vi.fn(),
  sendContractSignedStudent: vi.fn(),
  sendContractSignedStaff: vi.fn(),
});
const createCloudinaryMock = () => ({
  uploadBuffer: vi.fn(),
});
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createNotificationsMock = () => ({
  notifyUser: vi.fn(),
  notifyStaff: vi.fn(),
});
const createPdfStamperMock = () => ({
  stampContract: vi.fn(),
});
const createConfigMock = () => ({
  get: vi.fn().mockReturnValue('https://app.example.com'),
});

const makeContract = (overrides: Record<string, unknown> = {}) => ({
  contract_id: 77,
  scholar_profile_id: 11,
  contract_number: 'CTX-001',
  status: 'PENDING',
  effective_date: new Date('2026-01-01T00:00:00.000Z'),
  expiry_date: new Date('2030-01-01T00:00:00.000Z'),
  scholar_profile: {
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
    user: { user_id: 7, email: 'juan@example.com', role: 'APPLICANT' },
  },
  ...overrides,
});

const changesDto = {
  reason: 'My middle name is wrong',
};

describe('ContractSigningService', () => {
  let service: ContractSigningService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let cloudinary: ReturnType<typeof createCloudinaryMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;
  let pdfStamper: ReturnType<typeof createPdfStamperMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();
    cloudinary = createCloudinaryMock();
    events = createEventsMock();
    notifications = createNotificationsMock();
    pdfStamper = createPdfStamperMock();

    prisma.contract.findUnique.mockResolvedValue(makeContract());
    prisma.contract.update.mockResolvedValue(
      makeContract({ status: 'SIGNED' }),
    );
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          contract: prisma.contract,
          user: prisma.user,
        }),
    );

    cloudinary.uploadBuffer
      .mockResolvedValueOnce({ secure_url: 'https://cdn.test/sig.png' })
      .mockResolvedValueOnce({ secure_url: 'https://cdn.test/contract.pdf' });

    pdfStamper.stampContract.mockResolvedValue({
      stampedPdfBuffer: Buffer.from('pdf-bytes'),
      documentHash: 'b'.repeat(64),
      certificateId: 'VIA-CERT-2026-FFFF0000',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractSigningService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
        { provide: PdfStamperService, useValue: pdfStamper },
        { provide: ConfigService, useValue: createConfigMock() },
      ],
    }).compile();

    service = module.get<ContractSigningService>(ContractSigningService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('requestContractChanges', () => {
    it('throws NotFoundException when the contract does not exist', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);

      await expect(
        service.requestContractChanges(7, 999, changesDto),
      ).rejects.toThrow(new NotFoundException('Contract ID 999 not found.'));
    });

    it('throws NotFoundException when the contract belongs to another user', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({
          scholar_profile: { ...makeContract().scholar_profile, user_id: 99 },
        }),
      );

      await expect(
        service.requestContractChanges(7, 77, changesDto),
      ).rejects.toThrow(new NotFoundException('Contract ID 77 not found.'));
    });

    it('throws BadRequestException when the contract is already signed', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({ status: 'SIGNED' }),
      );

      await expect(
        service.requestContractChanges(7, 77, changesDto),
      ).rejects.toThrow(
        new BadRequestException(
          'This contract has already been signed and cannot be amended via change request.',
        ),
      );
    });

    it('throws BadRequestException when the contract was terminated', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({ status: 'TERMINATED' }),
      );

      await expect(
        service.requestContractChanges(7, 77, changesDto),
      ).rejects.toThrow(
        new BadRequestException(
          'This contract has been terminated and cannot be amended.',
        ),
      );
    });

    it('audits, notifies staff, and returns the pending request details', async () => {
      const result = await service.requestContractChanges(7, 77, changesDto);

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'CONTRACT_CHANGE_REQUESTED',
        expect.stringContaining('My middle name is wrong'),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'contract:changes_requested',
        objectMatching({
          contractId: 77,
          contractNumber: 'CTX-001',
          reason: 'My middle name is wrong',
        }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({
          title: 'Contract Revision Requested',
        }),
      );
      expect(result).toEqual({
        message:
          'Your change request has been submitted. The scholarship staff has been notified to review and update your agreement details.',
        contract_id: 77,
        contract_number: 'CTX-001',
        requested_reason: 'My middle name is wrong',
      });
    });

    it('does not email staff when there are no staff emails on file', async () => {
      mail.getStaffEmails.mockResolvedValue([]);

      await service.requestContractChanges(7, 77, changesDto);

      expect(mail.sendContractChangeRequestToStaff).not.toHaveBeenCalled();
    });

    it('emails staff when staff emails are available', async () => {
      mail.getStaffEmails.mockResolvedValue(['staff@example.com']);

      await service.requestContractChanges(7, 77, changesDto);

      expect(mail.sendContractChangeRequestToStaff).toHaveBeenCalledWith(
        ['staff@example.com'],
        objectMatching({
          studentEmail: 'juan@example.com',
          contractNumber: 'CTX-001',
          reason: 'My middle name is wrong',
        }),
      );
    });
  });

  describe('signContract', () => {
    const signingOptions = {
      signatureBuffer: Buffer.from('signature-png'),
      signerIp: '1.2.3.4',
      signerUserAgent: 'TestAgent 1.0',
    };

    it('throws BadRequestException when no signature is provided', async () => {
      await expect(
        service.signContract(7, 77, { signatureBase64: '' }),
      ).rejects.toThrow(
        new BadRequestException(
          'A valid signature image (uploaded file or signature_base64) is required to sign the contract.',
        ),
      );
    });

    it('accepts a base64 signature string and strips the data URL prefix', async () => {
      const pngBase64 = Buffer.from('png-bytes').toString('base64');

      await service.signContract(7, 77, {
        signatureBase64: `data:image/png;base64,${pngBase64}`,
      });

      expect(pdfStamper.stampContract).toHaveBeenCalledWith(
        objectMatching({
          signatureBuffer: Buffer.from('png-bytes'),
        }),
      );
    });

    it('throws NotFoundException when the contract does not exist', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);

      await expect(service.signContract(7, 77, signingOptions)).rejects.toThrow(
        new NotFoundException('Contract ID 77 not found.'),
      );
    });

    it('throws NotFoundException when the contract belongs to another user', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({
          scholar_profile: {
            ...makeContract().scholar_profile,
            user_id: 99,
          },
        }),
      );

      await expect(service.signContract(7, 77, signingOptions)).rejects.toThrow(
        new NotFoundException('Contract ID 77 not found.'),
      );
    });

    it('throws BadRequestException when the contract has already been signed', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({ status: 'SIGNED' }),
      );

      await expect(service.signContract(7, 77, signingOptions)).rejects.toThrow(
        new BadRequestException('This contract has already been signed.'),
      );
    });

    it('throws BadRequestException when the contract was terminated', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({ status: 'TERMINATED' }),
      );

      await expect(service.signContract(7, 77, signingOptions)).rejects.toThrow(
        new BadRequestException(
          'This contract has been terminated and cannot be signed.',
        ),
      );
    });

    it('uploads the signature and the stamped PDF to Cloudinary, promotes an APPLICANT user, and emits promotion events', async () => {
      const result = await service.signContract(7, 77, signingOptions);

      expect(cloudinary.uploadBuffer).toHaveBeenNthCalledWith(
        1,
        signingOptions.signatureBuffer,
        'viascholar/signatures',
        stringMatching(/^sig_CTX-001_\d+$/),
        'image',
      );
      expect(cloudinary.uploadBuffer).toHaveBeenNthCalledWith(
        2,
        Buffer.from('pdf-bytes'),
        'viascholar/signed-contracts',
        'contract_CTX-001_VIA-CERT-2026-FFFF0000',
        'auto',
      );
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.contract.update).toHaveBeenCalledWith({
        where: { contract_id: 77 },
        data: objectMatching({
          status: 'SIGNED',
          signed_by_user_id: 7,
          signed_document_url: 'https://cdn.test/contract.pdf',
          signature_url: 'https://cdn.test/sig.png',
          certificate_id: 'VIA-CERT-2026-FFFF0000',
          document_hash: 'b'.repeat(64),
          signer_ip: '1.2.3.4',
          signer_user_agent: 'TestAgent 1.0',
        }),
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { user_id: 7, role: Role.APPLICANT },
        data: { role: Role.SCHOLAR },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'CONTRACT_SIGNED',
        expect.stringContaining('VIA-CERT-2026-FFFF0000'),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'contract:signed',
        objectMatching({ certificateId: 'VIA-CERT-2026-FFFF0000' }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'contract:signed',
        objectMatching({ status: 'SIGNED' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'user:role_promoted',
        objectMatching({
          userId: 7,
          oldRole: 'APPLICANT',
          newRole: 'SCHOLAR',
        }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'user:role_promoted',
        objectMatching({ newRole: 'SCHOLAR' }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Agreement Signed' }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Role Promoted 🎉' }),
      );
      expect(result).toEqual(makeContract({ status: 'SIGNED' }));
    });

    it('does not emit promotion events when the user is already a scholar', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await service.signContract(7, 77, signingOptions);

      expect(events.emitToStaff).toHaveBeenCalledTimes(1);
      expect(events.emitToStaff).not.toHaveBeenCalledWith(
        'user:role_promoted',
        anyArg(Object),
      );
      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).not.toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Role Promoted 🎉' }),
      );
    });

    it('sends the signed contract email to the student and staff', async () => {
      mail.getStaffEmails.mockResolvedValue(['staff@example.com']);

      await service.signContract(7, 77, signingOptions);

      expect(mail.sendContractSignedStudent).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({
          studentName: 'Juan Dela Cruz',
          contractNumber: 'CTX-001',
        }),
      );
      await vi.waitFor(() =>
        expect(mail.sendContractSignedStaff).toHaveBeenCalledWith(
          ['staff@example.com'],
          objectMatching({ contractNumber: 'CTX-001' }),
        ),
      );
    });

    it('skips emails when the student has no email on file', async () => {
      prisma.contract.findUnique.mockResolvedValue(
        makeContract({
          scholar_profile: {
            ...makeContract().scholar_profile,
            user: null,
          },
        }),
      );

      await service.signContract(7, 77, signingOptions);

      expect(mail.sendContractSignedStudent).not.toHaveBeenCalled();
    });
  });
});
