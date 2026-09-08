import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { GradeCalculatorService } from './grade-calculator.service.js';
import { ConfirmDocumentDto } from './dto/confirm-document.dto.js';
import { VerifyDocumentDto } from './dto/verify-document.dto.js';
import { Application, Prisma } from '../generated/prisma/client.js';
import { EventsGateway } from '../events/events.gateway.js';

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

interface ExtractedGradeItem {
  subject_code?: string;
  subject_name?: string;
  units?: number | string;
  grade?: number | string;
}

interface ExtractedDocData {
  academic_year?: string;
  semester?: string;
  general_average?: number | string;
  grades?: ExtractedGradeItem[];
  [key: string]: unknown;
}

@Injectable()
export class DocumentEvaluationService {
  constructor(
    private prisma: PrismaService,
    private settingsService: SettingsService,
    private auditService: AuditService,
    private mailService: MailService,
    private gradeCalculatorService: GradeCalculatorService,
    private eventsGateway: EventsGateway,
  ) {}

  // Scholar confirms/corrects the OCR-extracted fields for review
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

    const extracted = (doc.extracted_data ?? {}) as ExtractedDocData;
    const generalAverage =
      dto.general_average != null
        ? Number(dto.general_average)
        : extracted.general_average != null
          ? Number(extracted.general_average)
          : undefined;

    const rawGrades = Array.isArray(extracted.grades) ? extracted.grades : [];
    const gradeItems = dto.grade_items?.length
      ? dto.grade_items.map((i) => ({
          subject_code: i.subject_code || i.subject_name || 'N/A',
          subject_name: i.subject_name || i.subject_code || 'N/A',
          units: i.units != null ? Number(i.units) : 1,
          grade: Number(i.grade),
        }))
      : rawGrades
          .filter((i) => i.grade != null && !isNaN(Number(i.grade)))
          .map((i) => ({
            subject_code: i.subject_code || i.subject_name || 'N/A',
            subject_name: i.subject_name || i.subject_code || 'N/A',
            units: i.units != null ? Number(i.units) : 1,
            grade: Number(i.grade),
          }));

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

    this.eventsGateway.emitToStaff('document:confirmed_by_applicant', {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      studentName:
        `${doc.scholar_profile.first_name} ${doc.scholar_profile.last_name}`.trim(),
      documentType: doc.document_type,
      generalAverage,
      gradeItemsCount: gradeItems.length,
      confirmedAt: new Date().toISOString(),
    });

    return updated;
  }

  // Staff requests re-upload / corrections on an unclear document
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
      void this.mailService.sendDocumentActionRequired(studentEmail, {
        studentName,
        documentType: doc.document_type,
        reason,
      });
    }

    const changesPayload = {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      studentName,
      documentType: doc.document_type,
      reason,
      requestedAt: new Date().toISOString(),
    };
    this.eventsGateway.emitToStaff('document:changes_requested', changesPayload);
    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:changes_requested',
        changesPayload,
      );
    }

    return updated;
  }

  // Coordinator confirms extracted grades & evaluates against school thresholds
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
    const extracted = (doc.extracted_data ?? {}) as ExtractedDocData;
    const rawGrades = Array.isArray(extracted.grades) ? extracted.grades : [];

    const gradeItems = dto.grade_items?.length
      ? dto.grade_items
      : confirmed?.grade_items?.length
        ? confirmed.grade_items
        : rawGrades
            .filter((i) => i.grade != null && !isNaN(Number(i.grade)))
            .map((i) => ({
              subject_code: i.subject_code || i.subject_name || 'N/A',
              subject_name: i.subject_name || i.subject_code || 'N/A',
              units: i.units != null ? Number(i.units) : 1,
              grade: Number(i.grade),
            }));

    if (gradeItems.length === 0) {
      throw new BadRequestException(
        'No grade items provided and no student-confirmed data available for this document.',
      );
    }

    const rawAcademicYear =
      dto.academic_year ??
      confirmed?.academic_year ??
      extracted.academic_year ??
      '';
    const academicYear =
      typeof rawAcademicYear === 'string' ? rawAcademicYear : '';

    const isForm138 = this.gradeCalculatorService.isForm138(
      doc.document_type || '',
      doc.label || '',
    );

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

    const { computedGwa, hasFailedGrade } =
      this.gradeCalculatorService.computeGwa({
        gradeItems,
        isForm138,
        explicitGeneralAvg,
        schoolConfig,
      });

    const normalizedAcademicYear =
      this.gradeCalculatorService.normalizeAcademicYear(academicYear);

    const normalizedSemester = this.gradeCalculatorService.normalizeSemester(
      extracted.semester,
      academicYear,
      isForm138,
    );

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
            subject_code: String(i.subject_code || i.subject_name || 'N/A'),
            subject_name: String(i.subject_name || i.subject_code || 'N/A'),
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

    const verifyPayload = {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      reportId: report.report_id,
      gwa: computedGwa,
      isEligible,
      evaluationFlag: evalFlag,
      verifiedAt: new Date().toISOString(),
    };
    this.eventsGateway.emitToStaff('document:verified', verifyPayload);
    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:verified',
        verifyPayload,
      );
    }

    if (updatedApplication) {
      const stagePayload = {
        applicationId: updatedApplication.application_id,
        scholarProfileId: updatedApplication.scholar_profile_id,
        stage: updatedApplication.stage,
        status: updatedApplication.status,
        updatedAt: new Date().toISOString(),
      };
      this.eventsGateway.emitToStaff('application:stage_updated', stagePayload);
      if (doc.scholar_profile?.user_id) {
        this.eventsGateway.emitToUser(
          doc.scholar_profile.user_id,
          'application:stage_updated',
          stagePayload,
        );
      }
    }

    return {
      report,
      isEligible,
      evaluationFlag: evalFlag,
      application: updatedApplication,
    };
  }
}
