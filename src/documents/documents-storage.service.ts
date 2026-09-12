import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PdfMergerService } from './pdf-merger.service.js';
import { FileForensicsService } from './file-forensics.service.js';
import { DocumentOcrService } from './document-ocr.service.js';
import { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class DocumentsStorageService {
  private readonly logger = new Logger(DocumentsStorageService.name);

  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private auditService: AuditService,
    private pdfMergerService: PdfMergerService,
    private fileForensicsService: FileForensicsService,
    private documentOcrService: DocumentOcrService,
  ) {}

  private isHighSchoolDocument(documentType: string): boolean {
    return /138|137|form\s*9|report\s*card|high\s*school|shs|senior\s*high/i.test(
      documentType,
    );
  }

  private getScholarYearLevel(scholarYearLevel?: number | null): number {
    return scholarYearLevel && scholarYearLevel > 0 ? scholarYearLevel : 1;
  }

  // 1. Scholar Uploads TOR / Form 137 / Form 138 (Supports single or multi-page/multi-file)
  async uploadDocument(
    userId: number,
    files: Express.Multer.File | Express.Multer.File[],
    documentType: string,
  ) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const yearLevel = this.getScholarYearLevel(scholar.current_year_level);
    if (yearLevel >= 2 && this.isHighSchoolDocument(documentType)) {
      throw new BadRequestException(
        `Scholars in Year Level ${yearLevel} (2nd to 4th year) are required to upload a Transcript of Records (TOR) or Certificate of Grades (COG). Form 138 / Form 9 / High School report cards are only permitted for 1st year students.`,
      );
    }

    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) {
      throw new BadRequestException('At least one file must be uploaded.');
    }

    // Inspect file metadata for digital editing artifacts (Photoshop, Canva, etc.)
    const metadataForensics =
      await this.fileForensicsService.inspectFileMetadata(fileList);

    // Merge multiple images/PDFs into a single multi-page PDF if needed
    const processed = await this.pdfMergerService.processAndMergeFiles(
      fileList,
      documentType,
    );

    // Upload buffer to Cloudinary
    const publicId = processed.fileName.replace(/\.[^/.]+$/, '');
    const cloudinaryResult = await this.cloudinaryService.uploadBuffer(
      processed.buffer,
      'viascholar/documents',
      publicId,
      'auto',
    );

    const fileType = processed.isPdf ? 'pdf' : 'image';

    // Create database entry in PENDING state with forensic metadata stored
    const document = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: documentType,
        label: documentType,
        file_name: processed.fileName,
        file_size: processed.fileSize,
        file_url: cloudinaryResult.secure_url,
        file_type: fileType,
        status: 'PENDING',
        extracted_data: {
          forensic_metadata: metadataForensics,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await this.auditService.log(
      userId,
      'DOCUMENT_UPLOADED',
      `Scholar (User ID: ${userId}) uploaded document (ID: ${document.document_id}, Type: ${documentType}, Files: ${fileList.length})${metadataForensics.is_flagged ? ` [Forensic Flags: ${metadataForensics.flags.join(', ')}]` : ''}.`,
    );

    // Send the document buffer to OCR engine (OpenRouter Vision or Parseur depending on OCR_PROVIDER)
    void this.documentOcrService
      .processDocumentExtraction(
        document.document_id,
        processed.buffer,
        processed.fileName,
        processed.mimeType,
        documentType,
        fileList,
      )
      ?.catch((err: Error) => {
        this.logger.error(
          `Automated OCR extraction failed for doc ${document.document_id}: ${err.message}`,
        );
      });

    return document;
  }

  // 1b. Scholar replaces / re-uploads document files (Draft & unverified states)
  async replaceDocument(
    userId: number,
    documentId: number,
    files: Express.Multer.File | Express.Multer.File[],
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.status === 'VERIFIED' || doc.status === 'STUDENT_CONFIRMED') {
      throw new BadRequestException(
        'Confirmed or verified documents cannot be replaced directly. Please contact a coordinator if corrections are required.',
      );
    }

    const yearLevel = this.getScholarYearLevel(
      doc.scholar_profile.current_year_level,
    );
    if (
      yearLevel >= 2 &&
      doc.document_type &&
      this.isHighSchoolDocument(doc.document_type)
    ) {
      throw new BadRequestException(
        `Scholars in Year Level ${yearLevel} (2nd to 4th year) are required to upload a Transcript of Records (TOR) or Certificate of Grades (COG). Form 138 / Form 9 / High School report cards are only permitted for 1st year students.`,
      );
    }

    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) {
      throw new BadRequestException('No files provided for replacement.');
    }

    // Inspect replacement file metadata for forensic anomalies
    const metadataForensics =
      await this.fileForensicsService.inspectFileMetadata(fileList);

    // Merge multiple files if necessary
    const processed = await this.pdfMergerService.processAndMergeFiles(
      fileList,
      doc.document_type || 'document',
    );

    const publicId = processed.fileName.replace(/\.[^/.]+$/, '');
    const cloudinaryResult = await this.cloudinaryService.uploadBuffer(
      processed.buffer,
      'viascholar/documents',
      publicId,
      'auto',
    );

    const fileType = processed.isPdf ? 'pdf' : 'image';

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        file_name: processed.fileName,
        file_size: processed.fileSize,
        file_url: cloudinaryResult.secure_url,
        file_type: fileType,
        status: 'PENDING',
        rejection_reason: null,
        extracted_data: {
          forensic_metadata: metadataForensics,
        } as unknown as Prisma.InputJsonValue,
        confirmed_data: Prisma.DbNull,
        verified_at: null,
        reviewed_by_employee_id: null,
      },
    });

    await this.auditService.log(
      userId,
      'DOCUMENT_REPLACED',
      `Scholar (User ID: ${userId}) replaced document (ID: ${documentId}, Type: ${doc.document_type}) with ${fileList.length} file(s)${metadataForensics.is_flagged ? ` [Forensic Flags: ${metadataForensics.flags.join(', ')}]` : ''}.`,
    );

    // Re-trigger OCR extraction (OpenRouter Vision or Parseur depending on OCR_PROVIDER)
    void this.documentOcrService
      .processDocumentExtraction(
        documentId,
        processed.buffer,
        processed.fileName,
        processed.mimeType,
        doc.document_type || 'document',
        fileList,
      )
      ?.catch((err: Error) => {
        this.logger.error(
          `Automated OCR extraction failed on replacement for doc ${documentId}: ${err.message}`,
        );
      });

    return updated;
  }

  // 1c. Scholar deletes an unverified draft document
  async deleteDocument(userId: number, documentId: number) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.status === 'VERIFIED' || doc.status === 'STUDENT_CONFIRMED') {
      throw new BadRequestException(
        'Confirmed or verified documents cannot be deleted. Please contact a coordinator if corrections are required.',
      );
    }

    const approvedReport = await this.prisma.gradeReport.findFirst({
      where: { document_id: documentId, status: 'APPROVED' },
    });

    if (approvedReport) {
      throw new BadRequestException(
        'This document is linked to an approved Grade Report and cannot be deleted.',
      );
    }

    // Discard any draft or non-approved grade reports associated with this document
    await this.prisma.gradeReport.deleteMany({
      where: { document_id: documentId, status: { not: 'APPROVED' } },
    });

    await this.prisma.scholarDocument.delete({
      where: { document_id: documentId },
    });

    await this.auditService.log(
      userId,
      'DOCUMENT_DELETED',
      `Scholar (User ID: ${userId}) deleted document (ID: ${documentId}, Type: ${doc.document_type}).`,
    );

    return {
      success: true,
      message: `Document ID ${documentId} deleted successfully.`,
    };
  }

  // 2. Scholar views their own documents (incl. OCR data & coordinator remarks)
  async getMyDocuments(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    return this.prisma.scholarDocument.findMany({
      where: { scholar_profile_id: scholar.profile_id },
      orderBy: { uploaded_at: 'desc' },
      select: {
        document_id: true,
        document_type: true,
        label: true,
        file_name: true,
        file_url: true,
        file_type: true,
        status: true,
        rejection_reason: true,
        extracted_data: true,
        confirmed_data: true,
        uploaded_at: true,
        verified_at: true,
      },
    });
  }

  // Staff views the full detail of a single document submission
  async getDocumentDetail(documentId: number) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: {
        scholar_profile: {
          include: { user: true, applications: true },
        },
      },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    return doc;
  }

  // Coordinator views pending documents for verification
  async getPendingDocuments() {
    return this.prisma.scholarDocument.findMany({
      where: {
        status: {
          in: [
            'PENDING',
            'PASSED_PRECHECK',
            'NEEDS_REUPLOAD',
            'STUDENT_CONFIRMED',
          ],
        },
      },
      orderBy: { uploaded_at: 'asc' },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });
  }

  // Get allowed document upload types based on scholar year level
  async getAllowedDocumentTypes(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const yearLevel = this.getScholarYearLevel(scholar.current_year_level);

    const isYear2Plus = yearLevel >= 2;

    const allowedTypes = isYear2Plus
      ? ['TOR', 'COG', 'Transcript of Records', 'Certificate of Grades']
      : [
          'Form 138',
          'Form 137',
          'Form 9',
          'High School Report Card',
          'TOR',
          'COG',
          'Transcript of Records',
          'Certificate of Grades',
        ];

    const prohibitedTypes = isYear2Plus
      ? ['Form 138', 'Form 137', 'Form 9', 'High School Report Card']
      : [];

    return {
      current_year_level: yearLevel,
      is_year_2_plus: isYear2Plus,
      allowed_types: allowedTypes,
      prohibited_types: prohibitedTypes,
      message: isYear2Plus
        ? 'As a 2nd-4th year scholar, you must submit a Transcript of Records (TOR) or Certificate of Grades (COG).'
        : 'As a 1st year student, you may submit Form 138 / Form 9 / High School Report Card or TOR.',
    };
  }
}
