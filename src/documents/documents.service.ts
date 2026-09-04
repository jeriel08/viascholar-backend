// src/documents/documents.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { VerifyDocumentDto } from './dto/verify-document.dto.js';
import { ConfirmDocumentDto } from './dto/confirm-document.dto.js';
import { QueryGradeReportsDto } from './dto/query-grade-reports.dto.js';
import { UpdateGradeReportStatusDto } from './dto/update-grade-report-status.dto.js';
import { MailService } from '../mail/mail.service.js';
import { ConfigService } from '@nestjs/config';
import { Application, Prisma } from '../generated/prisma/client.js';
import { PdfMergerService } from './pdf-merger.service.js';
import { DocumentForensicsService } from './document-forensics.service.js';

interface ConfirmedGradeData {
  academic_year?: string;
  general_average?: number;
  grade_items?: {
    subject_code?: string;
    subject_name?: string;
    units?: number;
    grade: number;
  }[];
}

interface ParseurFieldSet {
  grades?: unknown[];
  [key: string]: unknown;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private settingsService: SettingsService,
    private auditService: AuditService,
    private configService: ConfigService,
    private mailService: MailService,
    private pdfMergerService: PdfMergerService,
    private documentForensicsService: DocumentForensicsService,
  ) {}

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

    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) {
      throw new BadRequestException('At least one file must be uploaded.');
    }

    // Inspect file metadata for digital editing artifacts (Photoshop, Canva, etc.)
    const metadataForensics =
      await this.documentForensicsService.inspectFileMetadata(fileList);

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

    // Send the document buffer to Parseur for background OCR processing
    this.sendToParseur(
      document.document_id,
      processed.buffer,
      processed.fileName,
      processed.mimeType,
    ).catch((err) => {
      this.logger.error(
        `Parseur dispatch failed for doc ${document.document_id}: ${err.message}`,
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

    if (doc.status === 'VERIFIED') {
      throw new BadRequestException(
        'Verified documents cannot be replaced directly. Please contact a coordinator if corrections are required.',
      );
    }

    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) {
      throw new BadRequestException('No files provided for replacement.');
    }

    // Inspect replacement file metadata for forensic anomalies
    const metadataForensics =
      await this.documentForensicsService.inspectFileMetadata(fileList);

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

    // Re-trigger Parseur OCR
    this.sendToParseur(
      documentId,
      processed.buffer,
      processed.fileName,
      processed.mimeType,
    ).catch((err) => {
      this.logger.error(
        `Parseur re-dispatch failed for doc ${documentId}: ${err.message}`,
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

    if (doc.status === 'VERIFIED') {
      throw new BadRequestException(
        'Verified documents cannot be deleted. Please contact a coordinator if corrections are required.',
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

  // Helper method: Uploads the document buffer to the Parseur mailbox
  private async sendToParseur(
    documentId: number,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ) {
    const apiKey = this.configService.get<string>('PARSEUR_API_KEY');
    const mailboxId = this.configService.get<string>('PARSEUR_MAILBOX_ID');

    if (!apiKey || !mailboxId) {
      this.logger.warn(
        'Parseur credentials missing in .env. Skipping automated OCR trigger.',
      );
      return null;
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      fileName,
    );
    form.append('viascholar_document_id', String(documentId));

    const response = await fetch(
      `https://api.parseur.com/parser/${mailboxId}/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
        },
        body: form,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Parseur API responded with status ${response.status}: ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      attachments?: { DocumentID?: string | number }[];
    };

    this.logger.debug(
      `Parseur upload response for doc ${documentId}: ${JSON.stringify(data)}`,
    );

    const parseurDocId = data.attachments?.[0]?.DocumentID;
    if (parseurDocId != null) {
      await this.prisma.scholarDocument.update({
        where: { document_id: documentId },
        data: { parseur_doc_id: String(parseurDocId) },
      });
      this.logger.log(
        `Document ID ${documentId} dispatched to Parseur successfully (Parseur Doc ID: ${parseurDocId}).`,
      );
    } else {
      this.logger.warn(
        `Parseur upload succeeded for doc ${documentId} but no DocumentID was returned in the response.`,
      );
    }

    return data;
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

  async getExtractedData(
    userId: number,
    documentId: number,
    callerRole: string,
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const isOwner = doc.scholar_profile.user_id === userId;
    const isStaff = ['ADMIN', 'GRANTOR', 'COORDINATOR'].includes(callerRole);

    if (!isOwner && !isStaff) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const extracted = (doc.extracted_data as Record<string, any>) || {};
    const gradeCount = Array.isArray(extracted.grades)
      ? extracted.grades.length
      : 0;
    const isForm138 =
      /138|137|report card|high school/i.test(doc.document_type || '') ||
      /138|137|report card|high school/i.test(doc.label || '');

    const smartWarnings: string[] = [];
    if (['PENDING', 'PASSED_PRECHECK', 'NEEDS_REUPLOAD'].includes(doc.status)) {
      if (isForm138 && gradeCount > 0 && gradeCount < 6) {
        smartWarnings.push(
          `Only ${gradeCount} subjects were detected. If your Form 138 has multiple quarters/semesters across 2 pages (front & back), please verify both sides were uploaded or use 'Replace Document'.`,
        );
      }
      if (gradeCount > 0 && extracted.general_average == null) {
        smartWarnings.push(
          'General Average was not automatically detected on this document. You can manually enter your General Average or let the system compute it from subject grades.',
        );
      }
    }

    return {
      document_id: doc.document_id,
      document_type: doc.document_type,
      label: doc.label,
      file_url: doc.file_url,
      file_name: doc.file_name,
      file_size: doc.file_size,
      status: doc.status,
      rejection_reason: doc.rejection_reason,
      extracted_data: doc.extracted_data,
      confirmed_data: doc.confirmed_data,
      smart_warnings: smartWarnings,
      forensic_analysis: extracted.forensic_analysis || null,
      uploaded_at: doc.uploaded_at,
    };
  }


  // 3. Scholar confirms/corrects the OCR-extracted fields for review
  async confirmDocument(
    userId: number,
    documentId: number,
    dto: ConfirmDocumentDto,
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

    if (!['PENDING', 'PASSED_PRECHECK'].includes(doc.status)) {
      throw new BadRequestException(
        `Document ID ${documentId} cannot be confirmed while in '${doc.status}' status.`,
      );
    }

    const extracted = (doc.extracted_data as Record<string, any>) || {};
    const generalAverage =
      dto.general_average != null
        ? Number(dto.general_average)
        : extracted.general_average != null
          ? Number(extracted.general_average)
          : undefined;

    const gradeItems = dto.grade_items?.length
      ? dto.grade_items.map((i) => ({
          subject_code: i.subject_code || i.subject_name || 'N/A',
          subject_name: i.subject_name || i.subject_code || 'N/A',
          units: i.units != null ? Number(i.units) : 1,
          grade: Number(i.grade),
        }))
      : (extracted.grades as any[])
          ?.filter((i) => i.grade != null && !isNaN(Number(i.grade)))
          .map((i) => ({
            subject_code: i.subject_code || i.subject_name || 'N/A',
            subject_name: i.subject_name || i.subject_code || 'N/A',
            units: i.units != null ? Number(i.units) : 1,
            grade: Number(i.grade),
          })) || [];


    const confirmedData: ConfirmedGradeData = {
      academic_year: dto.academic_year || extracted.academic_year || undefined,
      general_average: generalAverage,
      grade_items: gradeItems,
    };

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'STUDENT_CONFIRMED',
        confirmed_data: confirmedData as unknown as Prisma.InputJsonValue,
        verified_at: null,
      },
    });

    await this.auditService.log(
      userId,
      'DOCUMENT_CONFIRMED',
      `Scholar confirmed document ID ${documentId} (${gradeItems.length} grade items, GA: ${generalAverage ?? 'N/A'}).`,
    );

    return updated;
  }

  // 4. Staff views the full detail of a single document submission
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

  // 5. Staff requests re-upload / corrections on an unclear document
  async requestChanges(
    employeeUserId: number,
    documentId: number,
    reason: string,
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'NEEDS_REUPLOAD',
        rejection_reason: reason,
        verified_at: null,
      },
    });

    await this.auditService.log(
      employeeUserId,
      'DOCUMENT_CHANGES_REQUESTED',
      `Staff requested changes on document ID ${documentId}: ${reason}`,
    );

    // Notify student that document needs re-upload
    const studentEmail = doc.scholar_profile?.user?.email;
    const studentName =
      `${doc.scholar_profile?.first_name} ${doc.scholar_profile?.last_name}`.trim() ||
      'Student';

    if (studentEmail) {
      this.mailService.sendDocumentActionRequired(studentEmail, {
        studentName,
        documentType: doc.document_type,
        reason,
      });
    }

    return updated;
  }

  // 6. Coordinator views pending documents for verification
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

  // 7. Coordinator confirms extracted grades & evaluates against school thresholds
  async verifyAndEvaluate(
    coordinatorUserId: number,
    documentId: number,
    dto: VerifyDocumentDto,
  ) {
    // Resolve the coordinator's employee_id from their user_id
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: coordinatorUserId },
    });

    if (!employee) {
      throw new NotFoundException(
        'Employee profile not found for current user.',
      );
    }

    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    // Manual entry wins; otherwise fall back to student-confirmed or extracted data
    const confirmed = doc.confirmed_data as ConfirmedGradeData | null;
    const extracted = (doc.extracted_data as Record<string, any>) || {};

    const gradeItems = dto.grade_items?.length
      ? dto.grade_items
      : confirmed?.grade_items?.length
        ? confirmed.grade_items
        : (extracted.grades as any[])
            ?.filter((i) => i.grade != null && !isNaN(Number(i.grade)))
            .map((i) => ({
              subject_code: i.subject_code || i.subject_name || 'N/A',
              subject_name: i.subject_name || i.subject_code || 'N/A',
              units: i.units != null ? Number(i.units) : 1,
              grade: Number(i.grade),
            })) || [];


    if (gradeItems.length === 0) {
      throw new BadRequestException(
        'No grade items provided and no student-confirmed data available for this document.',
      );
    }

    const academicYear =
      dto.academic_year ??
      confirmed?.academic_year ??
      extracted.academic_year ??
      '';

    const isForm138 =
      /138|137|report card|high school/i.test(doc.document_type || '') ||
      /138|137|report card|high school/i.test(doc.label || '');

    // Fetch school grading configuration if not Form 138
    const schoolName =
      doc.scholar_profile.school_name || 'University of Mindanao';
    const schoolConfig = !isForm138
      ? await this.prisma.schoolGradingSystem.findUnique({
          where: { school_name: schoolName },
        })
      : null;

    // Check for explicit general_average (from dto override, confirmed data, or OCR)
    const explicitGeneralAvg =
      dto.general_average != null
        ? Number(dto.general_average)
        : confirmed?.general_average != null
          ? Number(confirmed.general_average)
          : extracted.general_average != null
            ? Number(extracted.general_average)
            : undefined;

    let computedGwa = 0;
    let totalUnits = 0;
    let weightedSum = 0;
    let hasFailedGrade = false;

    if (explicitGeneralAvg != null && !isNaN(explicitGeneralAvg)) {
      computedGwa = explicitGeneralAvg;
      for (const item of gradeItems) {
        const grade = Number(item.grade);
        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        } else if (isForm138 && grade < 75.0) {
          // Standard high school passing mark is 75.0
          hasFailedGrade = true;
        }
      }
    } else if (isForm138) {
      // High School Form 138 calculation: Deduplicate MAPEH components if parent MAPEH is present
      const hasMapeh = gradeItems.some((i) =>
        /^mapeh$/i.test(i.subject_code || i.subject_name || ''),
      );
      const mapehSubSubjects = /^(music|arts|physical education|pe|health)$/i;

      const coreItems = hasMapeh
        ? gradeItems.filter(
            (i) =>
              !mapehSubSubjects.test(i.subject_name || '') &&
              !mapehSubSubjects.test(i.subject_code || ''),
          )
        : gradeItems;

      let sum = 0;
      for (const item of coreItems) {
        const grade = Number(item.grade);
        sum += grade;
        if (grade < 75.0) {
          hasFailedGrade = true;
        }
      }
      computedGwa = coreItems.length > 0 ? sum / coreItems.length : 0;
    } else {
      // College TOR / Certificate of Grades: Weighted by credit units
      for (const item of gradeItems) {
        const units = item.units != null ? Number(item.units) : 1;
        const grade = Number(item.grade);
        totalUnits += units;
        weightedSum += grade * units;

        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        }
      }
      computedGwa = totalUnits > 0 ? weightedSum / totalUnits : 0;
    }

    const normalizedAcademicYear =
      academicYear.match(/\d{4}\s*-\s*\d{4}/)?.[0]?.replace(/\s+/g, '') ??
      academicYear.slice(0, 15) ??
      'AY';

    let normalizedSemester = '1st Semester';
    if (extracted.semester && typeof extracted.semester === 'string') {
      normalizedSemester = extracted.semester;
    } else if (isForm138 && !/semester|sem/i.test(academicYear)) {
      normalizedSemester = 'Annual';
    } else if (/2nd/i.test(academicYear)) {
      normalizedSemester = '2nd Semester';
    } else if (/summer|midyear/i.test(academicYear)) {
      normalizedSemester = 'Summer';
    }


    // Evaluate GWA against retention threshold with scale awareness
    const globalSettings = await this.settingsService.getSettings();
    const meetsThreshold = this.settingsService.evaluateGwaThreshold(
      computedGwa,
      Number(globalSettings.grade_threshold),
      schoolConfig,
    );

    const isEligible = !hasFailedGrade && meetsThreshold;
    const evalFlag = !meetsThreshold
      ? 'BELOW_PASSING_MARK'
      : hasFailedGrade
        ? 'ACADEMIC_FAILURE'
        : 'CLEARED';

    // Save GradeReport & Items
    const report = await this.prisma.gradeReport.create({
      data: {
        scholar_profile_id: doc.scholar_profile_id,
        document_id: doc.document_id,
        academic_year: normalizedAcademicYear,
        semester: normalizedSemester,
        gpa: Number(computedGwa.toFixed(2)),
        status: isEligible ? 'APPROVED' : 'FLAGGED',
        is_eligible: isEligible,
        evaluation_flag: evalFlag,
        reviewed_by_employee_id: employee.employee_id,
        grade_items: {
          create: gradeItems.map((i) => ({
            subject_code: i.subject_code || i.subject_name || 'N/A',
            subject_name: i.subject_name || i.subject_code || 'N/A',
            units: i.units != null ? Number(i.units) : 1,
            grade: Number(i.grade),
          })),
        },
      },
      include: { grade_items: true },
    });

    // Mark document as VERIFIED with reviewer info
    await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'VERIFIED',
        verified_at: new Date(),
        reviewed_by_employee_id: employee.employee_id,
      },
    });

    // Lifecycle check: Only auto-progress Application if the user is an APPLICANT in onboarding
    const scholarUser = await this.prisma.user.findUnique({
      where: { user_id: doc.scholar_profile.user_id },
    });

    let updatedApplication: Application | null = null;

    if (scholarUser?.role === 'APPLICANT') {
      const application = await this.prisma.application.findFirst({
        where: { scholar_profile_id: doc.scholar_profile_id },
        orderBy: { submitted_at: 'desc' },
      });

      if (
        application &&
        ['PENDING', 'UNDER_REVIEW'].includes(application.status)
      ) {
        updatedApplication = await this.prisma.application.update({
          where: { application_id: application.application_id },
          data: {
            status: 'UNDER_REVIEW',
            stage: isEligible
              ? 'Document Verification Complete'
              : 'Flagged for Review',
            stage_updated_at: new Date(),
          },
        });
      }
    }

    await this.auditService.log(
      coordinatorUserId,
      'DOCUMENT_VERIFIED',
      `Coordinator verified document ID ${documentId}. Computed GWA: ${computedGwa.toFixed(2)}, Eligible: ${isEligible}` +
        (updatedApplication
          ? `; Application ID ${updatedApplication.application_id} moved to '${updatedApplication.stage}'`
          : ''),
    );

    return {
      report,
      isEligible,
      evaluationFlag: evalFlag,
      application: updatedApplication,
    };
  }

  // 8. Staff re-fetches Parseur results for documents whose webhook was missed
  async syncFromParseur(actorUserId: number, documentId: number) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (!doc.parseur_doc_id) {
      throw new BadRequestException(
        `Document ID ${documentId} was never dispatched to Parseur.`,
      );
    }

    const apiKey = this.configService.get<string>('PARSEUR_API_KEY');
    if (!apiKey) {
      throw new BadRequestException('PARSEUR_API_KEY is not configured.');
    }

    const response = await fetch(
      `https://api.parseur.com/document/${doc.parseur_doc_id}`,
      { headers: { Authorization: `Token ${apiKey}` } },
    );

    if (!response.ok) {
      throw new BadRequestException(
        `Parseur API responded with status ${response.status} for document ${doc.parseur_doc_id}.`,
      );
    }

    const meta = (await response.json()) as {
      status?: string;
      result?: string | Record<string, unknown> | null;
    };

    if (meta.status !== 'PARSEDOK') {
      return {
        synced: false,
        message: `Parseur has not finished processing this document (status: ${meta.status ?? 'UNKNOWN'}).`,
      };
    }

    let parsed: Record<string, unknown> | null = null;
    if (typeof meta.result === 'string') {
      try {
        parsed = JSON.parse(meta.result) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    } else if (meta.result && typeof meta.result === 'object') {
      parsed = meta.result;
    }

    const nestedFields =
      parsed && typeof parsed.fields === 'object' && parsed.fields !== null
        ? (parsed.fields as ParseurFieldSet)
        : null;
    const fields: ParseurFieldSet | null = nestedFields ?? parsed;

    if (!fields) {
      return {
        synced: false,
        message:
          'Parseur reported the document as processed but returned no parsable result.',
      };
    }

    const hasGrades = Array.isArray(fields.grades) && fields.grades.length > 0;
    const validationStatus = hasGrades ? 'PASSED_PRECHECK' : 'NEEDS_REUPLOAD';

    // Retrieve initial metadata forensics
    const existingExtracted = (doc.extracted_data as Record<string, any>) || {};
    const initialMetadataForensics = existingExtracted.forensic_metadata;

    const forensicEvaluation =
      this.documentForensicsService.evaluateExtractedDocument(
        doc.scholar_profile || {},
        doc.document_type || 'document',
        fields,
        initialMetadataForensics,
      );

    const mergedExtractedData = {
      ...fields,
      forensic_analysis: forensicEvaluation,
      validation_flags: forensicEvaluation.flags,
    };

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: validationStatus,
        extracted_data: mergedExtractedData as unknown as Prisma.InputJsonValue,
        rejection_reason: hasGrades
          ? null
          : 'Unreadable document or missing grade records.',
      },
    });

    await this.auditService.log(
      actorUserId,
      'DOCUMENT_SYNCED',
      `Staff synced Parseur results for document ID ${documentId}. Status: ${validationStatus}, Risk: ${forensicEvaluation.risk_level}, grade items: ${hasGrades ? fields.grades?.length : 0}.`,
    );

    return {
      synced: true,
      status: updated.status,
      extracted_data: updated.extracted_data,
      forensic_analysis: forensicEvaluation,
    };
  }


  // 9. Scholar views all their semestral grade reports (Grade Monitoring)
  async getMyGradeReports(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    return this.prisma.gradeReport.findMany({
      where: { scholar_profile_id: scholar.profile_id },
      orderBy: { submitted_at: 'desc' },
      include: {
        grade_items: true,
        document: {
          select: {
            document_id: true,
            document_type: true,
            file_name: true,
            file_url: true,
            status: true,
          },
        },
        reviewed_by_employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            title: true,
          },
        },
      },
    });
  }

  // 10. Staff views all semestral grade reports across scholars
  async getAllGradeReports(query: QueryGradeReportsDto) {
    const where: Prisma.GradeReportWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.academic_year) {
      where.academic_year = query.academic_year;
    }

    if (query.semester) {
      where.semester = query.semester;
    }

    if (query.search) {
      where.scholar_profile = {
        OR: [
          { first_name: { contains: query.search, mode: 'insensitive' } },
          { last_name: { contains: query.search, mode: 'insensitive' } },
          { student_number: { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }

    return this.prisma.gradeReport.findMany({
      where,
      orderBy: { submitted_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            user: { select: { user_id: true, email: true, role: true } },
          },
        },
        grade_items: true,
        document: {
          select: {
            document_id: true,
            document_type: true,
            file_name: true,
            file_url: true,
          },
        },
        reviewed_by_employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            title: true,
          },
        },
      },
    });
  }

  // 11. Staff updates or overrides a grade report review status
  async updateGradeReportStatus(
    coordinatorUserId: number,
    reportId: number,
    dto: UpdateGradeReportStatusDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: coordinatorUserId },
    });

    if (!employee) {
      throw new NotFoundException(
        'Employee profile not found for current user.',
      );
    }

    const report = await this.prisma.gradeReport.findUnique({
      where: { report_id: reportId },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });

    if (!report) {
      throw new NotFoundException(`Grade report ID ${reportId} not found.`);
    }

    const isEligible = dto.status === 'APPROVED';

    const updated = await this.prisma.gradeReport.update({
      where: { report_id: reportId },
      data: {
        status: dto.status,
        is_eligible: isEligible,
        remarks: dto.remarks ?? report.remarks,
        reviewed_at: new Date(),
        reviewed_by_employee_id: employee.employee_id,
      },
      include: {
        grade_items: true,
        scholar_profile: true,
        reviewed_by_employee: true,
      },
    });

    await this.auditService.log(
      coordinatorUserId,
      'GRADE_REPORT_STATUS_UPDATED',
      `Staff updated Grade Report ID ${reportId} status to ${dto.status}${dto.remarks ? `: ${dto.remarks}` : ''}`,
    );

    // Send email notification to scholar
    const studentEmail = report.scholar_profile?.user?.email;
    const studentName =
      `${report.scholar_profile?.first_name} ${report.scholar_profile?.last_name}`.trim() ||
      'Scholar';

    if (studentEmail) {
      this.mailService.sendGradeReportStatusUpdated(studentEmail, {
        studentName,
        academicYear: report.academic_year,
        semester: report.semester,
        status: dto.status,
        remarks: dto.remarks,
      });
    }

    return updated;
  }
}
