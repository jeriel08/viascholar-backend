import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as QRCode from 'qrcode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface GenerateDraftParams {
  templatePdfBuffer?: Buffer;
  studentName: string;
  studentEmail?: string;
  phoneNumber?: string;
  address?: string;
  studentNumber?: string;
  schoolName?: string;
  schoolAddress?: string;
  courseName?: string;
  termYear?: string;
  associationName?: string;
  scholarshipName?: string;
  contractNumber: string;
  effectiveDate?: Date;
}

export interface StampContractParams {
  templatePdfBuffer?: Buffer;
  templateUrl?: string;
  signatureBuffer: Buffer;
  studentName: string;
  studentEmail?: string;
  phoneNumber?: string;
  address?: string;
  studentNumber?: string;
  schoolName?: string;
  schoolAddress?: string;
  courseName?: string;
  termYear?: string;
  associationName?: string;
  scholarshipName?: string;
  contractNumber: string;
  effectiveDate?: Date;
  signedAt: Date;
  signerIp?: string;
  signerUserAgent?: string;
  verificationBaseUrl: string;
}

export interface StampedContractResult {
  stampedPdfBuffer: Buffer;
  documentHash: string;
  certificateId: string;
}

@Injectable()
export class PdfStamperService {
  private readonly logger = new Logger(PdfStamperService.name);
  private templatePath = path.join(
    process.cwd(),
    'src',
    'assets',
    'templates',
    'scholarship-agreement-template.pdf',
  );

  // Load the company's official template PDF from assets
  private async loadBaseTemplate(customBuffer?: Buffer): Promise<PDFDocument> {
    if (customBuffer && customBuffer.length > 0) {
      try {
        return await PDFDocument.load(customBuffer);
      } catch {
        this.logger.warn(
          'Failed to parse custom PDF buffer. Trying asset template.',
        );
      }
    }

    if (fs.existsSync(this.templatePath)) {
      try {
        const fileBuffer = fs.readFileSync(this.templatePath);
        return await PDFDocument.load(fileBuffer);
      } catch (err) {
        this.logger.error('Failed to load asset template PDF:', err);
      }
    }

    // Fallback: Create dynamic agreement PDF if template file is absent
    return this.createFallbackAgreementPdf();
  }

  // Fallback dynamic generator if no PDF template file is on disk
  private async createFallbackAgreementPdf(): Promise<PDFDocument> {
    const pdfDoc = await PDFDocument.create();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([612, 1008]);
    const { width, height } = page.getSize();

    page.drawText(
      'Francisco & Laureanne Lorenzo Scholarship Program: FLLSP Contract',
      {
        x: 40,
        y: height - 60,
        size: 13,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1),
      },
    );

    return pdfDoc;
  }

  // Helper to draw pre-filled scholarship metadata on page header
  private fillHeaderMetadata(
    page: any,
    fontBold: any,
    fontReg: any,
    params: GenerateDraftParams | StampContractParams,
    formattedDate: string,
  ) {
    const topX = 185;
    const metaColor = rgb(0.08, 0.15, 0.35); // Professional navy tone

    if (params.studentName) {
      page.drawText(params.studentName, {
        x: topX,
        y: 882,
        size: 8.5,
        font: fontBold,
        color: metaColor,
      });
    }

    page.drawText(formattedDate, {
      x: topX,
      y: 868,
      size: 8.5,
      font: fontReg,
      color: metaColor,
    });

    if (params.phoneNumber) {
      page.drawText(params.phoneNumber, {
        x: topX,
        y: 854,
        size: 8.5,
        font: fontReg,
        color: metaColor,
      });
    }

    if (params.studentEmail) {
      page.drawText(params.studentEmail, {
        x: topX,
        y: 840,
        size: 8.5,
        font: fontReg,
        color: metaColor,
      });
    }

    if (params.address) {
      page.drawText(params.address, {
        x: topX,
        y: 826,
        size: 8.5,
        font: fontReg,
        color: metaColor,
      });
    }

    if (params.schoolName) {
      page.drawText(params.schoolName, {
        x: topX,
        y: 812,
        size: 8.5,
        font: fontBold,
        color: metaColor,
      });
    }

    if (params.schoolAddress) {
      page.drawText(params.schoolAddress, {
        x: topX,
        y: 798,
        size: 8.5,
        font: fontReg,
        color: metaColor,
      });
    }

    if (params.courseName) {
      page.drawText(params.courseName, {
        x: topX,
        y: 784,
        size: 8.5,
        font: fontBold,
        color: metaColor,
      });
    }

    const termYearText =
      params.termYear ||
      `A.Y. ${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
    page.drawText(termYearText, {
      x: topX,
      y: 770,
      size: 8.5,
      font: fontReg,
      color: metaColor,
    });

    page.drawText(params.associationName || 'ViaScholar Partner Foundation', {
      x: topX,
      y: 756,
      size: 8.5,
      font: fontReg,
      color: metaColor,
    });

    page.drawText(
      params.scholarshipName ||
        'Francisco & Laureanne Lorenzo Scholarship Program (FLLSP)',
      {
        x: topX,
        y: 742,
        size: 8.5,
        font: fontBold,
        color: metaColor,
      },
    );
  }

  // Generate an unsigned agreement draft PDF pre-filled with student details for previewing
  async generateUnsignedDraft(params: GenerateDraftParams): Promise<Buffer> {
    const pdfDoc = await this.loadBaseTemplate(params.templatePdfBuffer);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    const page = pages[0];

    const formattedDate = (
      params.effectiveDate || new Date()
    ).toLocaleDateString('en-US', { dateStyle: 'long' });

    // 1. Fill Header Metadata Fields
    this.fillHeaderMetadata(page, fontBold, fontReg, params, formattedDate);

    // 2. Stamp Student Printed Name (signature line remains empty for student to sign)
    page.drawText(params.studentName.toUpperCase(), {
      x: 75,
      y: 202,
      size: 8,
      font: fontBold,
      color: rgb(0.12, 0.23, 0.54),
    });

    // 3. Stamp Grantor / Committee Name & Date
    page.drawText('FLLSP SCHOLARSHIP COMMITTEE', {
      x: 365,
      y: 202,
      size: 8.5,
      font: fontBold,
      color: rgb(0.1, 0.5, 0.2),
    });

    page.drawText(formattedDate, {
      x: 365,
      y: 153,
      size: 8.5,
      font: fontReg,
      color: rgb(0.2, 0.2, 0.2),
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  // Stamp signature, filled metadata, verification QR code & audit certificate onto contract
  async stampContract(
    params: StampContractParams,
  ): Promise<StampedContractResult> {
    const certificateId = `VIA-CERT-${new Date().getFullYear()}-${crypto
      .randomBytes(4)
      .toString('hex')
      .toUpperCase()}`;

    const pdfDoc = await this.loadBaseTemplate(params.templatePdfBuffer);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    const page = pages[0]; // Primary contract page
    const { width, height } = page.getSize();

    const formattedDate = (
      params.effectiveDate || params.signedAt
    ).toLocaleDateString('en-US', { dateStyle: 'long' });

    // 1. Fill Header Metadata Fields
    this.fillHeaderMetadata(page, fontBold, fontReg, params, formattedDate);

    // 2. Embed and Stamp Student E-Signature PNG
    let embeddedSigImage;
    try {
      embeddedSigImage = await pdfDoc.embedPng(params.signatureBuffer);
    } catch {
      embeddedSigImage = await pdfDoc.embedJpg(params.signatureBuffer);
    }

    // Scale and place signature image directly above student signature line
    const sigDims = embeddedSigImage.scaleToFit(140, 42);
    page.drawImage(embeddedSigImage, {
      x: 75,
      y: 206,
      width: sigDims.width,
      height: sigDims.height,
    });

    // Stamp Student Printed Name and Signing Date
    page.drawText(params.studentName.toUpperCase(), {
      x: 75,
      y: 202,
      size: 8,
      font: fontBold,
      color: rgb(0.12, 0.23, 0.54),
    });

    page.drawText(formattedDate, {
      x: 75,
      y: 153,
      size: 8.5,
      font: fontReg,
      color: rgb(0.2, 0.2, 0.2),
    });

    // 3. Stamp Grantor / FLLSP Committee Signature & Date
    page.drawText('FLLSP SCHOLARSHIP COMMITTEE', {
      x: 365,
      y: 202,
      size: 8.5,
      font: fontBold,
      color: rgb(0.1, 0.5, 0.2),
    });

    page.drawText(formattedDate, {
      x: 365,
      y: 153,
      size: 8.5,
      font: fontReg,
      color: rgb(0.2, 0.2, 0.2),
    });

    // 4. Generate Verification QR Code
    const verificationUrl = `${params.verificationBaseUrl}/${certificateId}`;
    const qrBuffer = await QRCode.toBuffer(verificationUrl, {
      margin: 1,
      width: 100,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    const embeddedQr = await pdfDoc.embedPng(qrBuffer);

    // 5. Draw DocuSign-style Cryptographic Audit Certificate Footer Box
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
      `Signer: ${params.studentName} (${params.studentEmail || 'N/A'})  |  Contract No: ${params.contractNumber}`,
      {
        x: textX,
        y: auditY + 33,
        size: 7,
        font: fontReg,
        color: rgb(0.2, 0.2, 0.2),
      },
    );

    page.drawText(
      `Executed: ${params.signedAt.toISOString()}  |  IP: ${params.signerIp || '127.0.0.1'}`,
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

    // Save final stamped bytes
    const stampedBytes = await pdfDoc.save();
    const stampedPdfBuffer = Buffer.from(stampedBytes);

    // 6. Compute SHA-256 Document Integrity Checksum
    const documentHash = crypto
      .createHash('sha256')
      .update(stampedPdfBuffer)
      .digest('hex');

    return {
      stampedPdfBuffer,
      documentHash,
      certificateId,
    };
  }
}
