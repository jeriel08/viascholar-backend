import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';
import { PdfCertificateService } from './pdf-certificate.service.js';

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

  constructor(
    private readonly pdfCertificateService: PdfCertificateService,
  ) {}

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
    const page = pdfDoc.addPage([612, 1008]);
    const { height } = page.getSize();

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
    const metaColor = rgb(0.08, 0.15, 0.35);

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

    // 2. Stamp Student Printed Name
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
    const certificateId = this.pdfCertificateService.generateCertificateId();

    const pdfDoc = await this.loadBaseTemplate(params.templatePdfBuffer);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    const page = pages[0];

    const formattedDate = (
      params.effectiveDate || params.signedAt
    ).toLocaleDateString('en-US', { dateStyle: 'long' });

    // 1. Fill Header Metadata Fields
    this.fillHeaderMetadata(page, fontBold, fontReg, params, formattedDate);

    // 2. Embed and Stamp Student E-Signature Image
    let embeddedSigImage;
    try {
      embeddedSigImage = await pdfDoc.embedPng(params.signatureBuffer);
    } catch {
      embeddedSigImage = await pdfDoc.embedJpg(params.signatureBuffer);
    }

    const sigDims = embeddedSigImage.scaleToFit(140, 42);
    page.drawImage(embeddedSigImage, {
      x: 75,
      y: 206,
      width: sigDims.width,
      height: sigDims.height,
    });

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
    const qrBuffer = await this.pdfCertificateService.generateQrBuffer(verificationUrl);
    const embeddedQr = await pdfDoc.embedPng(qrBuffer);

    // 5. Draw Cryptographic Audit Certificate Box
    this.pdfCertificateService.drawAuditCertificateBox({
      page,
      fontBold,
      fontReg,
      certificateId,
      studentName: params.studentName,
      studentEmail: params.studentEmail,
      contractNumber: params.contractNumber,
      signedAt: params.signedAt,
      signerIp: params.signerIp,
      verificationUrl,
      embeddedQr,
    });

    // Save final stamped bytes
    const stampedBytes = await pdfDoc.save();
    const stampedPdfBuffer = Buffer.from(stampedBytes);

    // 6. Compute SHA-256 Document Integrity Checksum
    const documentHash = this.pdfCertificateService.computeHash(stampedPdfBuffer);

    return {
      stampedPdfBuffer,
      documentHash,
      certificateId,
    };
  }
}
