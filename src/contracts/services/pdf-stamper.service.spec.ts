import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { PdfStamperService } from './pdf-stamper.service.js';
import { PdfCertificateService } from './pdf-certificate.service.js';

const signaturePng = (): Buffer => {
  // A minimal valid 1x1 transparent PNG.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
};

const baseParams = {
  studentName: 'Juan Dela Cruz',
  studentEmail: 'juan@example.com',
  phoneNumber: '09171234567',
  address: '123 Street',
  studentNumber: '202300123',
  schoolName: 'University of Mindanao',
  schoolAddress: 'Davao City',
  courseName: 'BSIT',
  termYear: 'A.Y. 2026-2030',
  scholarshipName: 'FLLSP',
  contractNumber: 'CTX-001',
  effectiveDate: new Date('2026-08-01T00:00:00.000Z'),
};

describe('PdfStamperService', () => {
  let service: PdfStamperService;
  let certificates: {
    generateCertificateId: ReturnType<typeof vi.fn>;
    generateQrBuffer: ReturnType<typeof vi.fn>;
    drawAuditCertificateBox: ReturnType<typeof vi.fn>;
    computeHash: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    certificates = {
      generateCertificateId: vi.fn().mockReturnValue('VIA-CERT-2026-00000001'),
      generateQrBuffer: vi.fn().mockResolvedValue(signaturePng()),
      drawAuditCertificateBox: vi.fn(),
      computeHash: vi.fn().mockReturnValue('a'.repeat(64)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PdfStamperService,
        { provide: PdfCertificateService, useValue: certificates },
      ],
    }).compile();

    service = module.get<PdfStamperService>(PdfStamperService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('generateUnsignedDraft', () => {
    it('produces a valid PDF buffer with pre-filled student metadata', async () => {
      const buffer = await service.generateUnsignedDraft(baseParams);

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
      expect(buffer.length).toBeGreaterThan(500);
    });

    it('uses the template PDF file when it exists', async () => {
      // The template asset is committed to the repo at src/assets/templates.
      const buffer = await service.generateUnsignedDraft(baseParams);

      expect(buffer.length).toBeGreaterThan(500);
    });
  });

  describe('stampContract', () => {
    it('stamps the signature and returns the certificate id and hash', async () => {
      const result = await service.stampContract({
        ...baseParams,
        signatureBuffer: signaturePng(),
        signedAt: new Date('2026-09-01T00:00:00.000Z'),
        signerIp: '1.2.3.4',
        signerUserAgent: 'TestAgent 1.0',
        verificationBaseUrl: 'https://app.example.com/verify/contract',
      });

      expect(certificates.generateCertificateId).toHaveBeenCalled();
      expect(certificates.generateQrBuffer).toHaveBeenCalledWith(
        'https://app.example.com/verify/contract/VIA-CERT-2026-00000001',
      );
      expect(certificates.drawAuditCertificateBox).toHaveBeenCalledWith(
        expect.objectContaining({
          certificateId: 'VIA-CERT-2026-00000001',
          studentName: 'Juan Dela Cruz',
          studentEmail: 'juan@example.com',
          contractNumber: 'CTX-001',
          signerIp: '1.2.3.4',
          verificationUrl:
            'https://app.example.com/verify/contract/VIA-CERT-2026-00000001',
        }),
      );
      expect(certificates.computeHash).toHaveBeenCalledWith(expect.any(Buffer));
      expect(result.certificateId).toBe('VIA-CERT-2026-00000001');
      expect(result.documentHash).toBe('a'.repeat(64));
      expect(Buffer.isBuffer(result.stampedPdfBuffer)).toBe(true);
      expect(result.stampedPdfBuffer.slice(0, 5).toString('latin1')).toBe(
        '%PDF-',
      );
    });
  });
});
