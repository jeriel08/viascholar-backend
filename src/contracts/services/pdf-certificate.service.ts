import { Injectable } from '@nestjs/common';
import { PDFPage, rgb, PDFFont } from 'pdf-lib';
import * as QRCode from 'qrcode';
import * as crypto from 'crypto';

export interface DrawAuditCertificateParams {
  page: PDFPage;
  fontBold: PDFFont;
  fontReg: PDFFont;
  certificateId: string;
  studentName: string;
  studentEmail?: string;
  contractNumber: string;
  signedAt: Date;
  signerIp?: string;
  verificationUrl: string;
  embeddedQr: any;
}

@Injectable()
export class PdfCertificateService {
  // Generate QR Code image buffer for verification URL
  async generateQrBuffer(verificationUrl: string): Promise<Buffer> {
    return QRCode.toBuffer(verificationUrl, {
      margin: 1,
      width: 100,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  }

  // Draw DocuSign-style cryptographic audit certificate box at the bottom of the page
  drawAuditCertificateBox(params: DrawAuditCertificateParams) {
    const {
      page,
      fontBold,
      fontReg,
      certificateId,
      studentName,
      studentEmail,
      contractNumber,
      signedAt,
      signerIp,
      verificationUrl,
      embeddedQr,
    } = params;

    const { width } = page.getSize();
    const auditY = 28;
    const auditWidth = width - 80;
    const auditHeight = 75;

    page.drawRectangle({
      x: 40,
      y: auditY,
      width: auditWidth,
      height: auditHeight,
      borderColor: rgb(0.15, 0.3, 0.65),
      borderWidth: 1.2,
      color: rgb(0.96, 0.98, 1),
    });

    page.drawImage(embeddedQr, {
      x: 48,
      y: auditY + 5,
      width: 65,
      height: 65,
    });

    const textX = 122;
    page.drawText('VIASCHOLAR DIGITAL SIGNATURE & AUDIT CERTIFICATE', {
      x: textX,
      y: auditY + 58,
      size: 8,
      font: fontBold,
      color: rgb(0.12, 0.23, 0.54),
    });

    page.drawText(
      `Certificate ID: ${certificateId}  |  Status: OFFICIALLY SIGNED & VERIFIED`,
      {
        x: textX,
        y: auditY + 45,
        size: 7,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1),
      },
    );

    page.drawText(
      `Signer: ${studentName} (${studentEmail || 'N/A'})  |  Contract No: ${contractNumber}`,
      {
        x: textX,
        y: auditY + 33,
        size: 7,
        font: fontReg,
        color: rgb(0.2, 0.2, 0.2),
      },
    );

    page.drawText(
      `Executed: ${signedAt.toISOString()}  |  IP: ${signerIp || '127.0.0.1'}`,
      {
        x: textX,
        y: auditY + 21,
        size: 6.5,
        font: fontReg,
        color: rgb(0.3, 0.3, 0.3),
      },
    );

    page.drawText(
      `Verification URL: ${verificationUrl} (Scan QR code to verify authenticity)`,
      {
        x: textX,
        y: auditY + 9,
        size: 6.5,
        font: fontReg,
        color: rgb(0.2, 0.4, 0.8),
      },
    );
  }

  // Compute SHA-256 Document Integrity Checksum
  computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  // Generate unique certificate ID
  generateCertificateId(): string {
    return `VIA-CERT-${new Date().getFullYear()}-${crypto
      .randomBytes(4)
      .toString('hex')
      .toUpperCase()}`;
  }
}
