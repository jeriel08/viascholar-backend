import { describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { PdfCertificateService } from './pdf-certificate.service.js';

const makePage = () => {
  const page = {
    getSize: vi.fn().mockReturnValue({ width: 612, height: 1008 }),
    drawRectangle: vi.fn(),
    drawText: vi.fn(),
    drawImage: vi.fn(),
  };
  return page;
};

describe('PdfCertificateService', () => {
  let service: PdfCertificateService;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PdfCertificateService],
    }).compile();

    service = module.get<PdfCertificateService>(PdfCertificateService);
  };

  it('is created by the Nest testing module', async () => {
    await build();

    expect(service).toBeDefined();
  });

  describe('computeHash', () => {
    it('produces an uppercase-free SHA-256 hex digest', async () => {
      await build();

      const hash = service.computeHash(Buffer.from('contract pdf bytes'));

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toHaveLength(64);
    });

    it('produces different hashes for different buffers', async () => {
      await build();

      const a = service.computeHash(Buffer.from('a'));
      const b = service.computeHash(Buffer.from('b'));

      expect(a).not.toBe(b);
    });

    it('produces the same hash for the same buffer', async () => {
      await build();

      const a = service.computeHash(Buffer.from('same'));
      const b = service.computeHash(Buffer.from('same'));

      expect(a).toBe(b);
    });
  });

  describe('generateCertificateId', () => {
    it('returns a VIA-CERT identifier with the current year and hex suffix', async () => {
      await build();

      const id = service.generateCertificateId();

      expect(id).toMatch(/^VIA-CERT-\d{4}-[0-9A-F]{8}$/);
    });

    it('returns different ids on subsequent calls', async () => {
      await build();

      expect(service.generateCertificateId()).not.toBe(
        service.generateCertificateId(),
      );
    });
  });

  describe('generateQrBuffer', () => {
    it('produces a non-empty PNG buffer for a URL', async () => {
      await build();

      const buffer = await service.generateQrBuffer(
        'https://app.example.com/verify/contract/VIA-CERT-2026-1234ABCD',
      );

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(100);
    });
  });

  describe('drawAuditCertificateBox', () => {
    it('draws a rectangle, text lines, and the QR image on the page', async () => {
      await build();
      const page = makePage();
      const embeddedQr = { width: 100, height: 100 } as never;

      service.drawAuditCertificateBox({
        page: page as never,
        fontBold: {} as never,
        fontReg: {} as never,
        certificateId: 'VIA-CERT-2026-ABCDEF12',
        studentName: 'Juan Dela Cruz',
        studentEmail: 'juan@example.com',
        contractNumber: 'CTX-001',
        signedAt: new Date('2026-09-01T00:00:00.000Z'),
        signerIp: '1.2.3.4',
        verificationUrl:
          'https://app.example.com/verify/contract/VIA-CERT-2026-ABCDEF12',
        embeddedQr,
      });

      expect(page.drawRectangle).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 40,
          y: 28,
          height: 75,
        }),
      );
      expect(page.drawImage).toHaveBeenCalledWith(
        embeddedQr,
        expect.any(Object),
      );
      expect(page.drawText).toHaveBeenCalledTimes(5);
      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('VIA-CERT-2026-ABCDEF12'),
        expect.any(Object),
      );
      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('Juan Dela Cruz'),
        expect.any(Object),
      );
      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('CTX-001'),
        expect.any(Object),
      );
      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('1.2.3.4'),
        expect.any(Object),
      );
      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('verify'),
        expect.any(Object),
      );
    });

    it('falls back to N/A when no student email and 127.0.0.1 when no signer IP', async () => {
      await build();
      const page = makePage();

      service.drawAuditCertificateBox({
        page: page as never,
        fontBold: {} as never,
        fontReg: {} as never,
        certificateId: 'VIA-CERT-2026-ABCDEF12',
        studentName: 'Juan Dela Cruz',
        contractNumber: 'CTX-001',
        signedAt: new Date('2026-09-01T00:00:00.000Z'),
        verificationUrl: 'https://app.example.com/verify',
        embeddedQr: { width: 100, height: 100 } as never,
      });

      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('N/A'),
        expect.any(Object),
      );
      expect(page.drawText).toHaveBeenCalledWith(
        expect.stringContaining('127.0.0.1'),
        expect.any(Object),
      );
    });
  });
});
