// src/documents/documents.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { VerifyDocumentDto } from './dto/verify-document.dto.js';
import { ConfigService } from '@nestjs/config';

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
    const cloudinaryResult = await this.cloudinaryService.uploadImage(
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

    // Send the Cloudinary URL to Parseur for background OCR processing
    this.sendToParseur(document.document_id, document.file_url).catch((err) => {
      this.logger.error(
        `Parseur dispatch failed for doc ${document.document_id}: ${err.message}`,
      );
    });

    return document;
  }

  // Helper method: Dispatches document URL to Parseur Mailbox
  private async sendToParseur(documentId: number, fileUrl: string) {
    const apiKey = this.configService.get<string>('PARSEUR_API_KEY');
    const mailboxId = this.configService.get<string>('PARSEUR_MAILBOX_ID');

    if (!apiKey || !mailboxId) {
      this.logger.warn(
        'Parseur credentials missing in .env. Skipping automated OCR trigger.',
      );
      return null;
    }

    const response = await fetch(
      `https://api.parseur.com/parser/${mailboxId}/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: fileUrl,
          custom_fields: {
            document_id: documentId, // Returned in webhook payload
          },
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Parseur API responded with status ${response.status}: ${errorBody}`,
      );
    }

    const data = await response.json();
    this.logger.log(
      `Document ID ${documentId} dispatched to Parseur successfully.`,
    );
    return data;
  }

  // 2. Coordinator views pending documents for verification
  async getPendingDocuments() {
    return this.prisma.scholarDocument.findMany({
      where: {
        status: {
          in: ['PENDING', 'PASSED_PRECHECK', 'NEEDS_REUPLOAD'],
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

  // 3. Coordinator confirms extracted grades & evaluates against school thresholds
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
    let failureReason = '';

    for (const item of dto.grade_items) {
      totalUnits += item.units;
      weightedSum += item.grade * item.units;

      if (schoolConfig) {
        const evaluation = this.settingsService.evaluateStudentGrade(
          item.grade,
          schoolConfig,
        );
        if (!evaluation.isPassing) {
          hasFailedGrade = true;
          failureReason = evaluation.statusLabel;
        }
      }
    }

    const computedGwa = totalUnits > 0 ? weightedSum / totalUnits : 0;
    const normalizedAcademicYear =
      dto.academic_year.match(/\d{4}-\d{4}/)?.[0] ??
      dto.academic_year.slice(0, 15);
    const normalizedSemester = /2nd/i.test(dto.academic_year)
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
          create: dto.grade_items.map((i) => ({
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

    await this.auditService.log(
      coordinatorUserId,
      'DOCUMENT_VERIFIED',
      `Coordinator verified document ID ${documentId}. Computed GWA: ${computedGwa.toFixed(2)}, Eligible: ${isEligible}`,
    );

    return { report, isEligible, evaluationFlag: evalFlag };
  }
}
