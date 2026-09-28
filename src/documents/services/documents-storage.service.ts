import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PdfMergerService } from './pdf-merger.service.js';
import { FileForensicsService } from './file-forensics.service.js';
import { DocumentOcrService } from './document-ocr.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';

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

  private isCollegeGradeDocument(documentType: string): boolean {
    return /ccg|certified|grades|tor|cog|transcript/i.test(documentType);
  }

  private getScholarYearLevel(scholarYearLevel?: number | null): number {
    return scholarYearLevel && scholarYearLevel > 0 ? scholarYearLevel : 1;
  }

  // 1. Scholar Uploads TOR / Form 137 / Form 138 / CCG
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
    const defaultDocType = yearLevel >= 2 ? 'TOR' : 'Form 138';
    const effectiveDocType =
      documentType && documentType.trim() !== ''
        ? documentType.trim()
        : defaultDocType;

    if (yearLevel >= 2 && this.isHighSchoolDocument(effectiveDocType)) {
      throw new BadRequestException(
        `Students in Year Level ${yearLevel} (2nd to 4th year) are required to upload an official College Transcript of Records (TOR). High School Form 138 / Form 9 cannot be accepted.`,
      );
    }
    if (
      yearLevel === 1 &&
      (effectiveDocType === 'TOR' ||
        (!this.isHighSchoolDocument(effectiveDocType) && effectiveDocType !== 'CCG'))
    ) {
      throw new BadRequestException(
        '1st-year applicants are only allowed to submit Senior High School Form 138 or Form 9 report cards, not a College Transcript of Records (TOR).',
      );
    }

    if (this.isCollegeGradeDocument(effectiveDocType) || effectiveDocType === 'CCG') {
      const unresolvedReport = await this.prisma.gradeReport.findFirst({
        where: {
          scholar_profile_id: scholar.profile_id,
          status: 'FLAGGED',
          appeal_status: { not: 'APPROVED' },
        },
        orderBy: { submitted_at: 'desc' },
      });
      if (unresolvedReport) {
        const msg =
          unresolvedReport.appeal_status === 'PENDING_GRANTOR'
            ? "Grade submission is paused while your academic appeal is awaiting the Grantor's verdict."
            : unresolvedReport.appeal_status === 'DENIED'
              ? 'Grade submission is unavailable because your scholarship was discontinued.'
              : 'Grade submission is paused. Please submit and resolve your Second Chance Appeal for your flagged grade report first.';
        throw new BadRequestException(msg);
      }
    }

    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) {
      throw new BadRequestException('At least one file must be uploaded.');
    }

    const metadataForensics =
      await this.fileForensicsService.inspectFileMetadata(fileList);
    const processed = await this.pdfMergerService.processAndMergeFiles(
      fileList,
      effectiveDocType,
    );

    const publicId = processed.fileName.replace(/\.[^/.]+$/, '');
    const cloudinaryResult = await this.cloudinaryService.uploadBuffer(
      processed.buffer,
      'viascholar/documents',
      publicId,
      'auto',
    );

    const fileType = processed.isPdf ? 'pdf' : 'image';

    const document = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: effectiveDocType,
        label:
          effectiveDocType === 'Form 138'
            ? 'Senior High School Report Card (Form 138 / Form 9)'
            : effectiveDocType === 'TOR'
              ? 'College Transcript of Records (TOR)'
              : effectiveDocType,
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
      `Scholar (User ID: ${userId}) uploaded document (ID: ${document.document_id}, Type: ${effectiveDocType}, Files: ${fileList.length})${metadataForensics.is_flagged ? ` [Forensic Flags: ${metadataForensics.flags.join(', ')}]` : ''}.`,
    );

    void this.documentOcrService
      .processDocumentExtraction(
        document.document_id,
        processed.buffer,
        processed.fileName,
        processed.mimeType,
        effectiveDocType,
        fileList,
      )
      ?.catch((err: Error) => {
        this.logger.error(
          `Automated OCR extraction failed for doc ${document.document_id}: ${err.message}`,
        );
      });

    return document;
  }

  // 1b. Scholar replaces / re-uploads document files
  async replaceDocument(
    userId: number,
    documentId: number,
    files: Express.Multer.File | Express.Multer.File[],
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });
    if (!doc || doc.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.status === 'VERIFIED' || doc.status === 'STUDENT_CONFIRMED') {
      throw new BadRequestException(
        'Confirmed or verified documents cannot be replaced directly.',
      );
    }

    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) {
      throw new BadRequestException('No files provided for replacement.');
    }

    const metadataForensics =
      await this.fileForensicsService.inspectFileMetadata(fileList);
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
      `Scholar (User ID: ${userId}) replaced document (ID: ${documentId}, Type: ${doc.document_type}) with ${fileList.length} file(s).`,
    );

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
    if (!doc || doc.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const approvedReport = await this.prisma.gradeReport.findFirst({
      where: { document_id: documentId, status: 'APPROVED' },
    });
    if (approvedReport) {
      throw new BadRequestException(
        'This document is linked to an approved Grade Report and cannot be deleted.',
      );
    }

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

  // 2. Scholar views their own documents
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

  // Staff views document details
  async getDocumentDetail(documentId: number) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: {
        scholar_profile: {
          include: {
            user: true,
            applications: true,
            school_grading_system: true,
          },
        },
      },
    });
    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }
    return doc;
  }

  // Coordinator views pending documents for verification (Grade Audits tab)
  async getPendingDocuments() {
    const docs = await this.prisma.scholarDocument.findMany({
      where: {
        scholar_profile: {
          user: {
            role: Role.SCHOLAR,
          },
        },
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
          include: {
            user: true,
            school_grading_system: true,
          },
        },
      },
    });

    // Prohibit enrollment/financial docs, TOR, and applicant admission forms (Form 138, Form 137, Form 9, SF9, etc.)
    const PROHIBITED_DOC_TYPES =
      /^(TOR|TRANSCRIPT|FORM\s*138|FORM\s*137|FORM\s*9|SF9|REPORT\s*CARD|SOA|COR|STATEMENT_OF_ACCOUNT|CERTIFICATE_OF_REGISTRATION|OFFICIAL_RECEIPT|RECEIPT|CONSOLIDATED|PROSPECTUS|CURRICULUM|HISTORICAL)/i;

    return docs.filter((doc) => {
      const type = (doc.document_type || '').trim();
      const label = (doc.label || '').trim();
      if (PROHIBITED_DOC_TYPES.test(type) || PROHIBITED_DOC_TYPES.test(label)) {
        return false;
      }
      return true;
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
      ? ['TOR', 'Transcript of Records', 'CCG', 'Certified Copy of Grades']
      : ['Form 138', 'Form 9', 'SF9', 'Form 137', 'High School Report Card', 'CCG'];

    const prohibitedTypes = isYear2Plus
      ? ['Form 138', 'Form 9', 'SF9', 'Form 137', 'High School Report Card']
      : ['TOR', 'Transcript of Records', 'College Transcript'];

    return {
      current_year_level: yearLevel,
      is_year_2_plus: isYear2Plus,
      allowed_types: allowedTypes,
      prohibited_types: prohibitedTypes,
      required_document: isYear2Plus
        ? 'College Transcript of Records (TOR)'
        : 'Senior High School Form 138 / Form 9',
      message: isYear2Plus
        ? 'As a 2nd to 4th year student, you are required to submit an official College Transcript of Records (TOR).'
        : 'As a 1st-year student, you are only allowed to submit your Senior High School Form 138 or Form 9 report card.',
    };
  }
}
