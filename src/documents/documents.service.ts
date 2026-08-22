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
import { ConfigService } from '@nestjs/config';
import type { Application, Prisma } from '../generated/prisma/client.js';

interface ConfirmedGradeData {
  academic_year?: string;
  grade_items?: {
    subject_code: string;
    subject_name?: string;
    units: number;
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
  ) {}

  // 1. Scholar Uploads TOR / Form 137
  async uploadDocument(
    userId: number,
    file: Express.Multer.File,
    documentType: string,
  ) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    // Upload image or PDF to Cloudinary
    const cloudinaryResult = await this.cloudinaryService.uploadDocument(
      file,
      'viascholar/documents',
    );

    const fileType = file.mimetype.includes('pdf') ? 'pdf' : 'image';

    // Create database entry in PENDING state
    const document = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: documentType,
        file_url: cloudinaryResult.secure_url,
        file_type: fileType,
        status: 'PENDING',
      },
    });

    // Send the document to Parseur for background OCR processing
    this.sendToParseur(document.document_id, file).catch((err) => {
      this.logger.error(
        `Parseur dispatch failed for doc ${document.document_id}: ${err.message}`,
      );
    });

    return document;
  }

  // Helper method: Uploads the document buffer to the Parseur mailbox
  private async sendToParseur(documentId: number, file: Express.Multer.File) {
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
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname,
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

    const parseurDocId = data.attachments?.[0]?.DocumentID;
    if (parseurDocId != null) {
      await this.prisma.scholarDocument.update({
        where: { document_id: documentId },
        data: { parseur_doc_id: String(parseurDocId) },
      });
    }

    this.logger.log(
      `Document ID ${documentId} dispatched to Parseur successfully.`,
    );
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

    return {
      document_id: doc.document_id,
      document_type: doc.document_type,
      label: doc.label,
      file_url: doc.file_url,
      status: doc.status,
      rejection_reason: doc.rejection_reason,
      extracted_data: doc.extracted_data,
      confirmed_data: doc.confirmed_data,
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

    const confirmedData = {
      academic_year: dto.academic_year ?? null,
      grade_items: (dto.grade_items ?? []).map((i) => ({
        subject_code: i.subject_code,
        subject_name: i.subject_name,
        units: i.units,
        grade: i.grade,
      })),
    };

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'STUDENT_CONFIRMED',
        confirmed_data: confirmedData,
        verified_at: null,
      },
    });

    await this.auditService.log(
      userId,
      'DOCUMENT_CONFIRMED',
      `Scholar confirmed document ID ${documentId} (${confirmedData.grade_items.length} grade items).`,
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
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    // Manual entry wins; otherwise fall back to student-confirmed data
    const confirmed = doc.confirmed_data as ConfirmedGradeData | null;
    const gradeItems = dto.grade_items?.length
      ? dto.grade_items
      : (confirmed?.grade_items ?? []);

    if (gradeItems.length === 0) {
      throw new BadRequestException(
        'No grade items provided and no student-confirmed data available for this document.',
      );
    }

    const academicYear = dto.academic_year ?? confirmed?.academic_year ?? '';

    // Fetch school grading configuration
    const schoolName =
      doc.scholar_profile.school_name || 'University of Mindanao';
    const schoolConfig = await this.prisma.schoolGradingSystem.findUnique({
      where: { school_name: schoolName },
    });

    // Calculate GWA & evaluate individual grades
    let totalUnits = 0;
    let weightedSum = 0;
    let hasFailedGrade = false;

    for (const item of gradeItems) {
      totalUnits += item.units;
      weightedSum += item.grade * item.units;

      if (schoolConfig) {
        const evaluation = this.settingsService.evaluateStudentGrade(
          item.grade,
          schoolConfig,
        );
        if (!evaluation.isPassing) {
          hasFailedGrade = true;
        }
      }
    }

    const computedGwa = totalUnits > 0 ? weightedSum / totalUnits : 0;
    const normalizedAcademicYear =
      academicYear.match(/\d{4}-\d{4}/)?.[0] ??
      academicYear.slice(0, 15) ??
      'AY';
    const normalizedSemester = /2nd/i.test(academicYear)
      ? '2nd Semester'
      : '1st Semester';

    // Check against global retention threshold (e.g. 90.00%)
    const globalSettings = await this.settingsService.getSettings();
    const meetsThreshold =
      computedGwa >= Number(globalSettings.grade_threshold);

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
        reviewed_by_employee_id: coordinatorUserId,
        grade_items: {
          create: gradeItems.map((i) => ({
            subject_code: i.subject_code,
            subject_name: i.subject_name,
            units: i.units,
            grade: i.grade,
          })),
        },
      },
      include: { grade_items: true },
    });

    // Mark document as VERIFIED
    await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: { status: 'VERIFIED' },
    });

    // Auto-progress the application while it is still awaiting review
    const application = await this.prisma.application.findFirst({
      where: { scholar_profile_id: doc.scholar_profile_id },
      orderBy: { submitted_at: 'desc' },
    });

    let updatedApplication: Application | null = null;

    if (application && application.status === 'PENDING') {
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

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: validationStatus,
        extracted_data: fields as unknown as Prisma.InputJsonValue,
        rejection_reason: hasGrades
          ? null
          : 'Unreadable document or missing grade records.',
      },
    });

    await this.auditService.log(
      actorUserId,
      'DOCUMENT_SYNCED',
      `Staff synced Parseur results for document ID ${documentId}. Status: ${validationStatus}, grade items: ${hasGrades ? fields.grades?.length : 0}.`,
    );

    return {
      synced: true,
      status: updated.status,
      extracted_data: updated.extracted_data,
    };
  }
}
