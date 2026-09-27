import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { GradeCalculatorService } from './grade-calculator.service.js';
import { ProspectusTransitionService } from './prospectus-transition.service.js';
import { DocumentConfirmationService } from './document-confirmation.service.js';
import { ConfirmDocumentDto } from '../dto/confirm-document.dto.js';
import { VerifyDocumentDto } from '../dto/verify-document.dto.js';
import { SchoolGradingSystem } from '../../generated/prisma/client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

interface ConfirmedGradeData {
  academic_year?: string;
  semester?: string;
  general_average?: number;
  grade_items?: {
    subject_code?: string;
    subject_name?: string;
    units?: number;
    grade: number;
  }[];
}

interface ExtractedDocData {
  academic_year?: string;
  semester?: string;
  school_name?: string;
  general_average?: number | string;
  grades?: {
    subject_code?: string;
    subject_name?: string;
    units?: number | string;
    grade?: number | string;
  }[];
}

@Injectable()
export class DocumentEvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly auditService: AuditService,
    private readonly gradeCalculatorService: GradeCalculatorService,
    private readonly prospectusTransitionService: ProspectusTransitionService,
    private readonly confirmationService: DocumentConfirmationService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  // Scholar confirms/corrects OCR-extracted fields
  confirmDocument(userId: number, documentId: number, dto: ConfirmDocumentDto) {
    return this.confirmationService.confirmDocument(userId, documentId, dto);
  }

  // Staff requests re-upload on unclear/inconsistent document
  requestChanges(employeeUserId: number, documentId: number, reason: string) {
    return this.confirmationService.requestChanges(
      employeeUserId,
      documentId,
      reason,
    );
  }

  // Coordinator verifies CCG / TOR, calculates GWA, transitions prospectus, and checks retention
  async verifyAndEvaluate(
    coordinatorUserId: number,
    documentId: number,
    dto: VerifyDocumentDto,
  ) {
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

    if (doc.status !== 'STUDENT_CONFIRMED') {
      throw new BadRequestException(
        `Cannot verify document: Student must confirm first (status: ${doc.status}).`,
      );
    }

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
        'No grade items available for this document.',
      );
    }

    const rawAY =
      dto.academic_year ??
      confirmed?.academic_year ??
      extracted.academic_year ??
      '';
    const academicYear = typeof rawAY === 'string' ? rawAY : '';
    const isForm138 = this.gradeCalculatorService.isForm138(
      doc.document_type || '',
      doc.label || '',
    );

    const schoolConfig = await this.resolveSchoolConfig(
      doc,
      extracted,
      isForm138,
    );

    const explicitGeneralAvg =
      dto.general_average != null
        ? Number(dto.general_average)
        : confirmed?.general_average != null
          ? Number(confirmed.general_average)
          : undefined;

    const { computedGwa, hasFailedGrade } =
      this.gradeCalculatorService.computeGwa({
        gradeItems,
        isForm138,
        explicitGeneralAvg,
        schoolConfig,
      });

    const normalizedAY =
      this.gradeCalculatorService.normalizeAcademicYear(academicYear);
    const normalizedSem = this.gradeCalculatorService.normalizeSemester(
      confirmed?.semester ?? extracted.semester,
      academicYear,
      isForm138,
    );

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

    // Find active term enrollment for this academic term
    const termEnrollment = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: doc.scholar_profile_id,
        academic_year: normalizedAY,
        semester: normalizedSem,
      },
    });

    // Create GradeReport record
    const report = await this.prisma.gradeReport.create({
      data: {
        scholar_profile_id: doc.scholar_profile_id,
        document_id: doc.document_id,
        academic_year: normalizedAY,
        semester: normalizedSem,
        gpa: Number(computedGwa.toFixed(2)),
        status: isEligible ? 'APPROVED' : 'FLAGGED',
        is_eligible: isEligible,
        evaluation_flag: evalFlag,
        reviewed_by_employee_id: employee.employee_id,
        term_enrollment_id: termEnrollment?.enrollment_id,
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

    // Mark document as VERIFIED
    await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'VERIFIED',
        verified_at: new Date(),
        reviewed_by_employee_id: employee.employee_id,
      },
    });

    // Transition prospectus subjects
    await this.prospectusTransitionService.transitionProspectusSubjects(
      doc.scholar_profile_id,
      gradeItems,
      normalizedAY,
      normalizedSem,
      schoolConfig,
    );

    // If eligible, update TermEnrollment status to COMPLETED
    if (termEnrollment && isEligible) {
      await this.prisma.termEnrollment.update({
        where: { enrollment_id: termEnrollment.enrollment_id },
        data: {
          status: 'COMPLETED',
          coordinator_notes: `Term grades verified (GWA: ${computedGwa.toFixed(2)}). Cleared for subsequent semester.`,
        },
      });
    }

    // Auto-progress application if in onboarding
    const updatedApplication =
      await this.prospectusTransitionService.checkOnboardingApplication(
        doc.scholar_profile_id,
        isEligible,
      );

    await this.auditService.log(
      coordinatorUserId,
      'DOCUMENT_VERIFIED',
      `Coordinator approved grades for doc #${documentId}. GWA: ${computedGwa.toFixed(2)}, Eligible: ${isEligible}`,
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
    this.eventsGateway.emitToStaff('grade_report:verified', verifyPayload);
    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:verified',
        verifyPayload,
      );
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'grade_report:verified',
        verifyPayload,
      );
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'baseline:prospectus_processed',
        verifyPayload,
      );

      const isGradeAudit = [
        'CCG',
        'GRADE_REPORT',
        'TOR',
        'GRADE_SLIP',
        'CERTIFIED_COPY_OF_GRADES',
      ].includes(doc.document_type);

      void this.notificationsService.notifyUser(doc.scholar_profile.user_id, {
        title: 'Documents Verified',
        message: isGradeAudit
          ? 'Your grade report has been verified by the coordinator.'
          : 'Your documents have been verified! Your application is now Under Review.',
        category: 'document',
        link: isGradeAudit ? '/ScholarGrade' : '/ApplicantsApplication',
      });
    }

    void this.notificationsService.notifyStaff({
      title: 'Documents Verified',
      message: `Applicant documents verified for ${doc.scholar_profile?.first_name || 'applicant'}.`,
      category: 'document',
      link: '/CoordinatorApplicants',
    });

    return {
      report,
      isEligible,
      evaluationFlag: evalFlag,
      application: updatedApplication,
    };
  }

  private async resolveSchoolConfig(
    doc: any,
    extracted: ExtractedDocData,
    isForm138: boolean,
  ): Promise<SchoolGradingSystem | null> {
    if (isForm138) return null;
    if (doc.scholar_profile?.school_id) {
      return this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: doc.scholar_profile.school_id },
      });
    }
    if (doc.scholar_profile?.school_name) {
      return this.prisma.schoolGradingSystem.findFirst({
        where: {
          school_name: {
            equals: doc.scholar_profile.school_name,
            mode: 'insensitive',
          },
        },
      });
    }
    if (extracted.school_name) {
      return this.prisma.schoolGradingSystem.findFirst({
        where: {
          school_name: {
            equals: String(extracted.school_name),
            mode: 'insensitive',
          },
        },
      });
    }
    return this.prisma.schoolGradingSystem.findFirst({
      where: { school_name: { contains: 'Mindanao', mode: 'insensitive' } },
    });
  }
}
