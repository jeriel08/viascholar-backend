import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { ConfirmDocumentDto } from '../dto/confirm-document.dto.js';
import { Prisma } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';
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
  general_average?: number | string;
  grades?: {
    subject_code?: string;
    subject_name?: string;
    units?: number | string;
    grade?: number | string;
  }[];
}

@Injectable()
export class DocumentConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  // 1. Scholar confirms/corrects OCR-extracted fields for coordinator audit
  async confirmDocument(
    userId: number,
    documentId: number,
    dto: ConfirmDocumentDto,
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: { include: { user: true } } },
    });

    if (!doc || doc.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    if (!['PENDING', 'PASSED_PRECHECK'].includes(doc.status)) {
      throw new BadRequestException(
        `Document ID ${documentId} cannot be confirmed while in '${doc.status}' status.`,
      );
    }

    let activeEnrollment: any = null;
    if (doc.document_type === 'CCG') {
      const unresolvedReport = await this.prisma.gradeReport.findFirst({
        where: {
          scholar_profile_id: doc.scholar_profile_id,
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

      activeEnrollment = await this.prisma.termEnrollment.findFirst({
        where: {
          scholar_profile_id: doc.scholar_profile_id,
          status: { not: 'COMPLETED' },
        },
        orderBy: { created_at: 'desc' },
      });

      if (!activeEnrollment || activeEnrollment.status !== 'APPROVED') {
        throw new BadRequestException(
          'You cannot confirm or submit grades without an approved start-of-term enrollment.',
        );
      }
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

        if (doc.document_type === 'CCG' && activeEnrollment) {
      const enrolledSubjects = (Array.isArray(activeEnrollment.enrolled_subjects)
        ? activeEnrollment.enrolled_subjects
        : []) as Array<{ subject_code?: string; descriptive_title?: string; units?: number }>;

      if (enrolledSubjects.length > 0) {
        const enrolledMap = new Map<string, { subject_code?: string; descriptive_title?: string }>();
        for (const sub of enrolledSubjects) {
          const norm = this.normalizeSubjectCode(sub.subject_code);
          if (norm) {
            enrolledMap.set(norm, sub);
          }
        }

        const matchedEnrolledCodes = new Set<string>();
        const extraSubjects: string[] = [];
        const missingGrades: string[] = [];

        for (const item of gradeItems) {
          const norm = this.normalizeSubjectCode(item.subject_code);
          if (!enrolledMap.has(norm)) {
            extraSubjects.push(item.subject_code || item.subject_name || 'N/A');
          } else {
            matchedEnrolledCodes.add(norm);
            if (item.grade == null || isNaN(Number(item.grade)) || Number(item.grade) <= 0) {
              missingGrades.push(item.subject_code || item.subject_name || 'N/A');
            }
          }
        }

        const missingEnrolled: string[] = [];
        for (const sub of enrolledSubjects) {
          const norm = this.normalizeSubjectCode(sub.subject_code);
          if (!matchedEnrolledCodes.has(norm)) {
            missingEnrolled.push(sub.subject_code || 'N/A');
          }
        }

        if (
          missingEnrolled.length > 0 ||
          extraSubjects.length > 0 ||
          missingGrades.length > 0 ||
          gradeItems.length === 0
        ) {
          const reasons: string[] = [];
          if (gradeItems.length === 0) {
            reasons.push('No course grades detected or provided');
          }
          if (missingEnrolled.length > 0) {
            reasons.push(`Missing enrolled course(s): ${missingEnrolled.join(', ')}`);
          }
          if (extraSubjects.length > 0) {
            reasons.push(`Course(s) not in approved enrollment: ${extraSubjects.join(', ')}`);
          }
          if (missingGrades.length > 0) {
            reasons.push(`Course(s) missing valid numeric grade: ${missingGrades.join(', ')}`);
          }
          throw new BadRequestException(
            `Subject mismatch: The submitted grades do not match your approved enrolled subjects for this term. ${reasons.join('; ')}`,
          );
        }
      }
    }

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

    const studentName =
      `${doc.scholar_profile.first_name} ${doc.scholar_profile.last_name}`.trim();
    const confirmedPayload = {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      studentName,
      documentType: doc.document_type,
      generalAverage,
      gradeItemsCount: gradeItems.length,
      confirmedAt: new Date().toISOString(),
    };

    this.eventsGateway.emitToStaff(
      'document:confirmed_by_applicant',
      confirmedPayload,
    );

    const isScholar = doc.scholar_profile?.user?.role === Role.SCHOLAR;
    const isGradeDoc =
      isScholar &&
      [
        'CCG',
        'GRADE_REPORT',
        'GRADE_SLIP',
        'CERTIFIED_COPY_OF_GRADES',
        'Certificate of Grades',
      ].includes(doc.document_type);
    if (isGradeDoc) {
      this.eventsGateway.emitToStaff(
        'grade_report:submitted',
        confirmedPayload,
      );
      void this.notificationsService.notifyStaff({
        title: 'New Grade Audit Awaiting Review',
        message: `${studentName || 'A scholar'} submitted ${doc.document_type || 'grades'} for end-of-term audit.`,
        category: 'document',
        link: '/CoordinatorMonitor',
      });
    } else {
      void this.notificationsService.notifyStaff({
        title: 'Documents Confirmed',
        message: `${studentName || 'An applicant'} confirmed their document details.`,
        category: 'document',
        link: '/CoordinatorApplicants',
      });
    }

    if (doc.document_type === 'CCG') {
      const activeEnrollment = await this.prisma.termEnrollment.findFirst({
        where: {
          scholar_profile_id: doc.scholar_profile_id,
          status: 'APPROVED',
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

        this.eventsGateway.emitToUser(
          doc.scholar_profile.user_id,
          'enrollment:updated',
          {
            enrollment_id: activeEnrollment.enrollment_id,
            status: 'COMPLETED',
          },
        );
      }
    }

    return updated;
  }

  // 2. Staff requests re-upload on unclear/inconsistent document
  async requestChanges(
    employeeUserId: number,
    documentId: number,
    reason: string,
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: { include: { user: true } } },
    });

    if (!doc)
      throw new NotFoundException(`Document ID ${documentId} not found.`);

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
      `Staff requested changes on #${documentId}: ${reason}`,
    );

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

    const payload = {
      documentId,
      scholarProfileId: doc.scholar_profile_id,
      studentName,
      documentType: doc.document_type,
      reason,
      requestedAt: new Date().toISOString(),
    };
    this.eventsGateway.emitToStaff('document:changes_requested', payload);
    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:changes_requested',
        payload,
      );

      void this.notificationsService.notifyUser(doc.scholar_profile.user_id, {
        title: 'Document Revision Needed',
        message:
          reason ||
          'Please review your documents and re-upload required files.',
        category: 'document',
        link: '/ApplicantsApplication',
      });
    }

    void this.notificationsService.notifyStaff({
      title: 'Document Revision Requested',
      message: `Revisions were requested for ${studentName || 'applicant'}'s documents.`,
      category: 'document',
      link: '/CoordinatorApplicants',
    });

    return updated;
  }
  private normalizeSubjectCode(code?: string): string {
    if (!code) return '';
    return code
      .trim()
      .toUpperCase()
      .replace(/[\s\-_./\\]+/g, '')
      .replace(/(?<=[A-Z])III$/g, '3')
      .replace(/(?<=[A-Z])II$/g, '2')
      .replace(/(?<=[A-Z])I$/g, '1');
  }
}
