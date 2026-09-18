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
import { Application, Prisma, SchoolGradingSystem } from '../generated/prisma/client.js';
import { EventsGateway } from '../events/events.gateway.js';

interface ConfirmedGradeData {
  academic_year?: string;
  semester?: string;
  general_average?: number;
  grade_items?: { subject_code?: string; subject_name?: string; units?: number; grade: number }[];
}

interface ExtractedDocData {
  academic_year?: string;
  semester?: string;
  school_name?: string;
  general_average?: number | string;
  grades?: { subject_code?: string; subject_name?: string; units?: number | string; grade?: number | string }[];
}

@Injectable()
export class DocumentEvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly gradeCalculatorService: GradeCalculatorService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Scholar confirms/corrects OCR-extracted fields for coordinator audit
  async confirmDocument(userId: number, documentId: number, dto: ConfirmDocumentDto) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc || doc.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (!['PENDING', 'PASSED_PRECHECK'].includes(doc.status)) {
      throw new BadRequestException(`Document ID ${documentId} cannot be confirmed while in '${doc.status}' status.`);
    }

    const extracted = (doc.extracted_data ?? {}) as ExtractedDocData;
    const generalAverage = dto.general_average != null
      ? Number(dto.general_average)
      : extracted.general_average != null ? Number(extracted.general_average) : undefined;

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
      semester: dto.semester || extracted.semester || undefined,
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
      `Scholar confirmed document ID ${documentId} (${gradeItems.length} items, GA: ${generalAverage ?? 'N/A'}).`,
    );

    const studentName = `${doc.scholar_profile.first_name} ${doc.scholar_profile.last_name}`.trim();
    const confirmedPayload = {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      studentName,
      documentType: doc.document_type,
      generalAverage,
      gradeItemsCount: gradeItems.length,
      confirmedAt: new Date().toISOString(),
    };

    this.eventsGateway.emitToStaff('document:confirmed_by_applicant', confirmedPayload);

    const isGradeDoc = ['CCG', 'GRADE_REPORT', 'TOR', 'GRADE_SLIP', 'CERTIFIED_COPY_OF_GRADES'].includes(doc.document_type);
    if (isGradeDoc) {
      this.eventsGateway.emitToStaff('grade_report:submitted', confirmedPayload);
    }

    // Submitting CCG signifies the previous semester has completed.
    // Transition any active/endorsed enrollment to COMPLETED so the scholar can enroll for the next semester.
    if (doc.document_type === 'CCG') {
      const activeEnrollment = await this.prisma.termEnrollment.findFirst({
        where: {
          scholar_profile_id: doc.scholar_profile_id,
          status: { in: ['APPROVED', 'SUBMITTED', 'PENDING_REVIEW'] },
        },
        orderBy: { created_at: 'desc' },
      });

      if (activeEnrollment) {
        await this.prisma.termEnrollment.update({
          where: { enrollment_id: activeEnrollment.enrollment_id },
          data: {
            status: 'COMPLETED',
            coordinator_notes: activeEnrollment.coordinator_notes
              ? `${activeEnrollment.coordinator_notes} | Semester concluded with CCG submission.`
              : 'Semester concluded with CCG submission. Ready for next term enrollment.',
          },
        });

        this.eventsGateway.emitToUser(doc.scholar_profile.user_id, 'enrollment:updated', {
          enrollment_id: activeEnrollment.enrollment_id,
          status: 'COMPLETED',
        });
      }
    }

    return updated;
  }

  // 2. Staff requests re-upload on unclear/inconsistent document
  async requestChanges(employeeUserId: number, documentId: number, reason: string) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: { include: { user: true } } },
    });

    if (!doc) throw new NotFoundException(`Document ID ${documentId} not found.`);

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: { status: 'NEEDS_REUPLOAD', rejection_reason: reason, verified_at: null },
    });

    await this.auditService.log(employeeUserId, 'DOCUMENT_CHANGES_REQUESTED', `Staff requested changes on #${documentId}: ${reason}`);

    const studentEmail = doc.scholar_profile?.user?.email;
    const studentName = `${doc.scholar_profile?.first_name} ${doc.scholar_profile?.last_name}`.trim() || 'Student';

    if (studentEmail) {
      void this.mailService.sendDocumentActionRequired(studentEmail, { studentName, documentType: doc.document_type, reason });
    }

    const payload = { documentId, scholarProfileId: doc.scholar_profile_id, studentName, documentType: doc.document_type, reason, requestedAt: new Date().toISOString() };
    this.eventsGateway.emitToStaff('document:changes_requested', payload);
    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(doc.scholar_profile.user_id, 'document:changes_requested', payload);
    }

    return updated;
  }

  // 3. Coordinator verifies CCG / TOR, calculates GWA, transitions prospectus, and checks retention
  async verifyAndEvaluate(coordinatorUserId: number, documentId: number, dto: VerifyDocumentDto) {
    const employee = await this.prisma.employee.findUnique({ where: { user_id: coordinatorUserId } });
    if (!employee) throw new NotFoundException('Employee profile not found for current user.');

    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });
    if (!doc) throw new NotFoundException(`Document ID ${documentId} not found.`);

    if (doc.status !== 'STUDENT_CONFIRMED') {
      throw new BadRequestException(`Cannot verify document: Student must confirm first (status: ${doc.status}).`);
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

    if (gradeItems.length === 0) throw new BadRequestException('No grade items available for this document.');

    const rawAY = dto.academic_year ?? confirmed?.academic_year ?? extracted.academic_year ?? '';
    const academicYear = typeof rawAY === 'string' ? rawAY : '';
    const isForm138 = this.gradeCalculatorService.isForm138(doc.document_type || '', doc.label || '');

    const schoolConfig = await this.resolveSchoolConfig(doc, extracted, isForm138);

    const explicitGeneralAvg = dto.general_average != null
      ? Number(dto.general_average)
      : confirmed?.general_average != null ? Number(confirmed.general_average) : undefined;

    const { computedGwa, hasFailedGrade } = this.gradeCalculatorService.computeGwa({
      gradeItems,
      isForm138,
      explicitGeneralAvg,
      schoolConfig,
    });

    const normalizedAY = this.gradeCalculatorService.normalizeAcademicYear(academicYear);
    const normalizedSem = this.gradeCalculatorService.normalizeSemester(
      confirmed?.semester ?? extracted.semester,
      academicYear,
      isForm138,
    );

    const globalSettings = await this.settingsService.getSettings();
    const meetsThreshold = this.settingsService.evaluateGwaThreshold(computedGwa, Number(globalSettings.grade_threshold), schoolConfig);

    const isEligible = !hasFailedGrade && meetsThreshold;
    const evalFlag = !meetsThreshold ? 'BELOW_PASSING_MARK' : hasFailedGrade ? 'ACADEMIC_FAILURE' : 'CLEARED';

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
      data: { status: 'VERIFIED', verified_at: new Date(), reviewed_by_employee_id: employee.employee_id },
    });

    // Prospectus State Transition: Transition ENROLLED/UNTAKEN subjects to PASSED or FAILED
    await this.transitionProspectusSubjects(doc.scholar_profile_id, gradeItems, normalizedAY, normalizedSem, schoolConfig);

    // If eligible, update TermEnrollment status to COMPLETED (clearing pipeline for next term)
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
    const updatedApplication = await this.checkOnboardingApplication(doc.scholar_profile_id, isEligible);

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
      this.eventsGateway.emitToUser(doc.scholar_profile.user_id, 'document:verified', verifyPayload);
      this.eventsGateway.emitToUser(doc.scholar_profile.user_id, 'grade_report:verified', verifyPayload);
      this.eventsGateway.emitToUser(doc.scholar_profile.user_id, 'baseline:prospectus_processed', verifyPayload);
    }

    return { report, isEligible, evaluationFlag: evalFlag, application: updatedApplication };
  }

  private async resolveSchoolConfig(doc: any, extracted: ExtractedDocData, isForm138: boolean): Promise<SchoolGradingSystem | null> {
    if (isForm138) return null;
    if (doc.scholar_profile.school_id) {
      return this.prisma.schoolGradingSystem.findUnique({ where: { school_id: doc.scholar_profile.school_id } });
    }
    if (doc.scholar_profile.school_name) {
      return this.prisma.schoolGradingSystem.findFirst({
        where: { school_name: { equals: doc.scholar_profile.school_name, mode: 'insensitive' } },
      });
    }
    if (extracted.school_name) {
      return this.prisma.schoolGradingSystem.findFirst({
        where: { school_name: { equals: String(extracted.school_name), mode: 'insensitive' } },
      });
    }
    return this.prisma.schoolGradingSystem.findFirst({
      where: { school_name: { contains: 'Mindanao', mode: 'insensitive' } },
    });
  }

  private async transitionProspectusSubjects(
    scholarProfileId: number,
    gradeItems: { subject_code?: string; subject_name?: string; grade: number }[],
    academicYear: string,
    semester: string,
    schoolConfig: SchoolGradingSystem | null,
  ) {
    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
      include: { subjects: true },
    });

    if (!prospectus || !prospectus.subjects?.length) return;

    const clean = (s?: string | null) => (s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

    for (const item of gradeItems) {
      const normCode = clean(item.subject_code);
      const normName = clean(item.subject_name);

      const match = prospectus.subjects.find((ps) => {
        const psCode = clean(ps.subject_code);
        const psTitle = clean(ps.descriptive_title);
        if (normCode && psCode && (psCode === normCode || psCode.includes(normCode) || normCode.includes(psCode))) return true;
        if (normName && psTitle && (psTitle === normName || psTitle.includes(normName) || normName.includes(psTitle))) return true;
        if (normCode && psTitle && (psTitle === normCode || psTitle.includes(normCode))) return true;
        return false;
      });

      if (match) {
        const numGrade = Number(item.grade);
        const isPassing = schoolConfig
          ? this.settingsService.evaluateStudentGrade(item.grade, schoolConfig).isPassing
          : !isNaN(numGrade) && (numGrade <= 3.0 || numGrade >= 75.0);

        await this.prisma.prospectusSubject.update({
          where: { subject_id: match.subject_id },
          data: {
            status: isPassing ? 'PASSED' : 'FAILED',
            grade: isNaN(numGrade) ? null : numGrade,
            credited_term: `${academicYear} ${semester}`,
            remarks: `${isPassing ? 'Passed' : 'Failed'} in AY ${academicYear} ${semester}`,
          },
        });
      }
    }
  }

  private async checkOnboardingApplication(scholarProfileId: number, isEligible: boolean): Promise<Application | null> {
    const profile = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: scholarProfileId },
      include: { user: true },
    });

    if (profile?.user?.role !== 'APPLICANT') return null;

    const application = await this.prisma.application.findFirst({
      where: { scholar_profile_id: scholarProfileId },
      orderBy: { submitted_at: 'desc' },
    });

    if (application && ['PENDING', 'UNDER_REVIEW'].includes(application.status)) {
      return this.prisma.application.update({
        where: { application_id: application.application_id },
        data: {
          status: 'UNDER_REVIEW',
          stage: isEligible ? 'Document Verification Complete' : 'Flagged for Review',
          stage_updated_at: new Date(),
        },
      });
    }

    return null;
  }
}
