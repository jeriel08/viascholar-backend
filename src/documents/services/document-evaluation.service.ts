import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { GradeCalculatorService } from './grade-calculator.service.js';
import { ProspectusTransitionService } from './prospectus-transition.service.js';
import { DocumentConfirmationService } from './document-confirmation.service.js';
import { ConfirmDocumentDto } from '../dto/confirm-document.dto.js';
import { VerifyDocumentDto } from '../dto/verify-document.dto.js';
import { Prisma, SchoolGradingSystem } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import {
  findMatchingTermEnrollment,
  normalizeAcademicYear,
  normalizeSemester,
} from '../utils/academic-term.util.js';

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
    @Optional() private readonly cacheService?: AppCacheService,
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
      include: { scholar_profile: { include: { user: true } } },
    });
    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.status === 'VERIFIED') {
      throw new BadRequestException('Document is already verified.');
    }

    if (
      doc.status !== 'STUDENT_CONFIRMED' &&
      !dto.bypass_student_confirmation
    ) {
      throw new BadRequestException(
        `Cannot verify document: Student must confirm first (status: ${doc.status}).`,
      );
    }

    const isForm138 = this.gradeCalculatorService.isForm138(
      doc.document_type || '',
      doc.label || '',
    );
    const isScholar = doc.scholar_profile?.user?.role === Role.SCHOLAR;

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

    // Retroactive verification of a bypassed Form 9 / Form 138 for an already-promoted Scholar:
    // Mark VERIFIED without creating a new college GradeReport that could skew active GWA or probation checks.
    if (dto.bypass_student_confirmation && isScholar && isForm138) {
      const verifiedAt = new Date();
      const confirmedPayload =
        doc.confirmed_data ??
        (gradeItems.length > 0 || dto.academic_year || dto.general_average != null
          ? {
              academic_year:
                dto.academic_year ??
                (typeof extracted.academic_year === 'string'
                  ? extracted.academic_year
                  : undefined),
              general_average:
                dto.general_average != null
                  ? Number(dto.general_average)
                  : extracted.general_average != null &&
                      !isNaN(Number(extracted.general_average))
                    ? Number(extracted.general_average)
                    : undefined,
              grade_items: gradeItems,
            }
          : undefined);

      const updatedDoc = await this.prisma.scholarDocument.update({
        where: { document_id: documentId },
        data: {
          status: 'VERIFIED',
          verified_at: verifiedAt,
          reviewed_by_employee_id: employee.employee_id,
          rejection_reason: null,
          ...(confirmedPayload
            ? { confirmed_data: confirmedPayload as Prisma.InputJsonValue }
            : {}),
        },
      });

      await this.auditService.log(
        coordinatorUserId,
        'DOCUMENT_VERIFIED',
        `Staff retroactively verified bypassed admission document #${documentId} (${doc.document_type}) for scholar #${doc.scholar_profile_id}.${dto.notes ? ` Notes: ${dto.notes}` : ''}`,
      );

      const verifyPayload = {
        documentId,
        scholarProfileId: doc.scholar_profile_id,
        verifiedAt: verifiedAt.toISOString(),
      };
      this.eventsGateway.emitToStaff('document:verified', verifyPayload);
      if (doc.scholar_profile?.user_id) {
        this.eventsGateway.emitToUser(
          doc.scholar_profile.user_id,
          'document:verified',
          verifyPayload,
        );
      }

      if (this.cacheService) {
        await this.cacheService.delPattern('dashboard:');
        await this.cacheService.delPattern('baseline:');
      }

      return {
        document: updatedDoc,
        report: null,
        isEligible: true,
        evaluationFlag: 'CLEARED',
        second_chance_exhausted: false,
        application: null,
      };
    }

    if (gradeItems.length === 0) {
      throw new BadRequestException(
        'No grade items available for this document.',
      );
    }

    const isCcg = doc.document_type === 'CCG';
    // For CCGs the scholar-confirmed term has already been canonicalized to the
    // approved enrollment term, so a coordinator override must not replace it.
    // Other grade documents keep the existing override behavior.
    const rawAY = isCcg
      ? (confirmed?.academic_year ??
        extracted.academic_year ??
        dto.academic_year ??
        '')
      : (dto.academic_year ??
        confirmed?.academic_year ??
        extracted.academic_year ??
        '');
    const academicYear = typeof rawAY === 'string' ? rawAY : '';

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
      normalizeAcademicYear(academicYear) ||
      this.gradeCalculatorService.normalizeAcademicYear(academicYear);
    const rawSemester = confirmed?.semester ?? extracted.semester;
    const normalizedSem =
      normalizeSemester(rawSemester) ||
      this.gradeCalculatorService.normalizeSemester(
        rawSemester,
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

    // Find the term enrollment for this academic term. CCG/grade audits must
    // map to a real enrollment so a document for a different school year or
    // semester cannot create a phantom term in reports and analytics.
    const scholarEnrollments = await this.prisma.termEnrollment.findMany({
      where: { scholar_profile_id: doc.scholar_profile_id },
      orderBy: { created_at: 'desc' },
    });
    const termEnrollment = findMatchingTermEnrollment(
      scholarEnrollments,
      normalizedAY,
      normalizedSem,
    );

    if (isCcg) {
      if (!termEnrollment) {
        throw new BadRequestException(
          `Academic term mismatch: This CCG is marked as ${normalizedAY} • ${normalizedSem}, but no term enrollment exists for that term. Please verify the CCG's school year and semester against the scholar's approved enrollment.`,
        );
      }

      if (!['APPROVED', 'COMPLETED'].includes(termEnrollment.status)) {
        throw new BadRequestException(
          `Academic term mismatch: The scholar's ${normalizedAY} • ${normalizedSem} enrollment is not approved (status: ${termEnrollment.status}). Grade audits can only be verified against an approved term enrollment.`,
        );
      }
    }

    // Check if the scholar has already used their 1-time Second Chance Appeal
    const priorResolvedAppeal =
      !isEligible && typeof this.prisma.gradeReport?.findFirst === 'function'
        ? await this.prisma.gradeReport.findFirst({
            where: {
              scholar_profile_id: doc.scholar_profile_id,
              appeal_status: { in: ['APPROVED', 'DENIED'] },
            },
          })
        : null;
    const isSecondChanceExhausted =
      !isEligible &&
      (doc.scholar_profile?.academic_baseline_status === 'ON_PROBATION' ||
        Boolean(priorResolvedAppeal));

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
        ...(isSecondChanceExhausted
          ? {
              appeal_status: 'DENIED',
              appeal_reviewed_at: new Date(),
              appeal_reviewed_by_employee_id: employee.employee_id,
              appeal_decision_notes:
                'Second Chance probation exhausted. Automatic archival triggered due to subsequent academic retention deficiency.',
            }
          : {}),
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

    // If scholar already used their 1-time Second Chance and failed again,
    // automatically archive them (keeping user.is_active = true for read-only portal access)
    // and terminate active contracts / cancel pending disbursements.
    if (isSecondChanceExhausted) {
      const archiveNotes = `Failed 2nd-chance probation during ${normalizedAY} (${normalizedSem}) with GWA ${computedGwa.toFixed(2)}. ${dto.notes || ''}`.trim();

      if (typeof this.prisma.scholarProfile?.update === 'function') {
        await this.prisma.scholarProfile.update({
          where: { profile_id: doc.scholar_profile_id },
          data: {
            academic_baseline_status: 'DISCONTINUED',
            archived_at: new Date(),
            archived_by_user_id: coordinatorUserId,
            archive_reason: 'FAILED_SECOND_CHANCE',
            archive_notes: archiveNotes,
          },
        });
      }

      if (typeof this.prisma.contract?.updateMany === 'function') {
        await this.prisma.contract.updateMany({
          where: {
            scholar_profile_id: doc.scholar_profile_id,
            status: { in: ['SIGNED', 'PENDING'] },
          },
          data: { status: 'TERMINATED' },
        });
      }

      if (typeof this.prisma.disbursement?.updateMany === 'function') {
        await this.prisma.disbursement.updateMany({
          where: {
            scholar_profile_id: doc.scholar_profile_id,
            status: { in: ['PENDING', 'AUTHORIZED'] },
          },
          data: {
            status: 'CANCELLED',
            remarks: `Scholarship archived: Failed 2nd-chance probation for ${normalizedAY} ${normalizedSem}.`,
          },
        });
      }
    }

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
      const verificationNote = `Term grades verified (GWA: ${computedGwa.toFixed(2)}). Cleared for subsequent semester.`;

      await this.prisma.termEnrollment.update({
        where: { enrollment_id: termEnrollment.enrollment_id },
        data: {
          status: 'COMPLETED',
          coordinator_notes: termEnrollment.coordinator_notes
            ? `${termEnrollment.coordinator_notes} | ${verificationNote}`
            : verificationNote,
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
      secondChanceExhausted: isSecondChanceExhausted,
      verifiedAt: new Date().toISOString(),
    };
    this.eventsGateway.emitToStaff('document:verified', verifyPayload);
    this.eventsGateway.emitToStaff('grade_report:verified', verifyPayload);
    if (isSecondChanceExhausted) {
      const studentName =
        `${doc.scholar_profile?.first_name || ''} ${doc.scholar_profile?.last_name || ''}`.trim() ||
        'Scholar';

      await this.auditService.log(
        coordinatorUserId,
        'SCHOLAR_ARCHIVED_SECOND_CHANCE_FAILED',
        `Automatically archived scholar '${studentName}' (Profile #${doc.scholar_profile_id}) after failing 2nd-chance probation (${normalizedAY} ${normalizedSem}, GWA: ${computedGwa.toFixed(2)}).`,
      );

      this.eventsGateway.emitToStaff('scholar:archived', {
        profile_id: doc.scholar_profile_id,
        report_id: report.report_id,
        archive_reason: 'FAILED_SECOND_CHANCE',
      });
      if (doc.scholar_profile?.user_id) {
        this.eventsGateway.emitToUser(
          doc.scholar_profile.user_id,
          'scholar:archived',
          {
            profile_id: doc.scholar_profile_id,
            report_id: report.report_id,
            archive_reason: 'FAILED_SECOND_CHANCE',
          },
        );
      }

      const staffNotif = {
        title: 'Scholar Archived: 2nd Chance Failed',
        message: `${studentName} failed retention requirements while on 2nd-chance probation (${normalizedAY} ${normalizedSem}, GWA: ${computedGwa.toFixed(2)}) and has been moved to the Archive.`,
        category: 'academic',
        link: '/grantArchive',
      };
      if (typeof this.notificationsService?.createForRoles === 'function') {
        void this.notificationsService.createForRoles(
          [Role.GRANTOR, Role.COORDINATOR],
          staffNotif,
        );
      } else {
        void this.notificationsService.notifyStaff(staffNotif);
      }

      if (doc.scholar_profile?.user_id) {
        void this.notificationsService.notifyUser(doc.scholar_profile.user_id, {
          title: 'Scholarship Archived: 2nd Chance Exhausted',
          message: `Your grade report for ${normalizedAY} (${normalizedSem}) fell below the retention threshold after using your Second Chance Appeal. Your scholarship has been archived. You can still view your records and email the Grantor directly from your dashboard.`,
          category: 'academic',
          link: '/scholardashboard',
        });
      }
    } else {
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

        const isScholar = doc.scholar_profile?.user?.role === Role.SCHOLAR;
        const isGradeAudit =
          isScholar &&
          [
            'CCG',
            'GRADE_REPORT',
            'GRADE_SLIP',
            'CERTIFIED_COPY_OF_GRADES',
            'Certificate of Grades',
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
    }

    if (this.cacheService) {
      await this.cacheService.delPattern('dashboard:');
      if (dto.bypass_student_confirmation) {
        await this.cacheService.delPattern('baseline:');
      }
    }

    return {
      report,
      isEligible,
      evaluationFlag: evalFlag,
      second_chance_exhausted: isSecondChanceExhausted,
      application: updatedApplication,
    };
  }

  /**
   * Staff (Coordinator / Grantor / Admin) directly marks a bypassed or non-grade
   * document as VERIFIED from the Scholar Full Details view.
   */
  async staffVerifyDocument(
    staffUserId: number,
    documentId: number,
    notes?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: staffUserId },
    });
    if (!employee) {
      throw new NotFoundException(
        'Employee profile not found for current user.',
      );
    }

    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: { include: { user: true } } },
    });
    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (doc.status === 'VERIFIED') {
      throw new BadRequestException('Document is already verified.');
    }

    const verifiedAt = new Date();
    const updatedDocument = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'VERIFIED',
        verified_at: verifiedAt,
        reviewed_by_employee_id: employee.employee_id,
        rejection_reason: null,
      },
      include: {
        reviewed_by_employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
          },
        },
      },
    });

    await this.auditService.log(
      staffUserId,
      'DOCUMENT_VERIFIED',
      `Staff verified document #${documentId} (${doc.document_type}) for scholar #${doc.scholar_profile_id} (previous status: ${doc.status}).${notes?.trim() ? ` Notes: ${notes.trim()}` : ''}`,
    );

    const verifyPayload = {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      verifiedAt: verifiedAt.toISOString(),
    };
    this.eventsGateway.emitToStaff('document:verified', verifyPayload);
    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:verified',
        verifyPayload,
      );
      void this.notificationsService.notifyUser(doc.scholar_profile.user_id, {
        title: 'Document Verified',
        message: `Your ${doc.label || doc.document_type} document has been verified by scholarship staff.`,
        category: 'document',
        link:
          doc.scholar_profile.user.role === Role.SCHOLAR
            ? '/schoProfile'
            : '/ApplicantsApplication',
      });
    }

    if (this.cacheService) {
      await this.cacheService.delPattern('dashboard:');
      await this.cacheService.delPattern('baseline:');
    }

    return {
      document: updatedDocument,
      message: 'Document verified successfully.',
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
