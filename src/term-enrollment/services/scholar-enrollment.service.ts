import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EnrollmentOcrService } from './enrollment-ocr.service.js';
import { EnrollmentAuditEngineService } from './enrollment-audit-engine.service.js';
import { SubmitEnrollmentDto } from '../dto/submit-enrollment.dto.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { Express } from 'express';

@Injectable()
export class ScholarEnrollmentService {
  private readonly logger = new Logger(ScholarEnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
    private readonly cloudinaryService: CloudinaryService,
    private readonly enrollmentOcrService: EnrollmentOcrService,
    private readonly auditEngineService: EnrollmentAuditEngineService,
    @Optional() private readonly cacheService?: AppCacheService,
  ) {}

  private async syncEnrolledSubjectsToProspectus(
    scholar: any,
    enrolledSubjects: any[],
    academicYear: string,
    semester: string,
    subjectsAudit?: any[],
  ) {
    if (!Array.isArray(enrolledSubjects) || enrolledSubjects.length === 0) {
      return;
    }
    const prospectusSubjects = scholar.prospectus?.subjects;
    if (!Array.isArray(prospectusSubjects) || prospectusSubjects.length === 0) {
      return;
    }
    const prospectusSubjectModel = (this.prisma as any).prospectusSubject;
    if (!prospectusSubjectModel?.update) {
      return;
    }

    const normalizeCode = (code: string) =>
      typeof (this.enrollmentOcrService as any)?.normalizeSubjectCode ===
      'function'
        ? (this.enrollmentOcrService as any).normalizeSubjectCode(code)
        : (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    const getBaseCode = (code: string) =>
      typeof (this.enrollmentOcrService as any)?.getBaseSubjectCode ===
      'function'
        ? (this.enrollmentOcrService as any).getBaseSubjectCode(code)
        : normalizeCode(code).replace(/(LAB|LEC|L)$/, '');

    const normalizeTitle = (title: string) =>
      (title || '')
        .toLowerCase()
        .replace(/\b(lab|laboratory|lec|lecture)\b/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();

    let updatedCount = 0;

    for (let i = 0; i < enrolledSubjects.length; i++) {
      const sub = enrolledSubjects[i];
      const auditItem = Array.isArray(subjectsAudit) ? subjectsAudit[i] : null;
      const targetId =
        sub.curriculum_subject_id || auditItem?.curriculum_subject_id;

      let matchingSubject = targetId
        ? prospectusSubjects.find(
            (ps: any) => ps.subject_id === Number(targetId),
          )
        : undefined;

      if (!matchingSubject && sub.subject_code) {
        const normCode = normalizeCode(sub.subject_code);
        matchingSubject = prospectusSubjects.find(
          (ps: any) => normalizeCode(ps.subject_code) === normCode,
        );
      }

      if (!matchingSubject && sub.subject_code) {
        const baseCode = getBaseCode(sub.subject_code);
        if (baseCode) {
          matchingSubject =
            prospectusSubjects.find(
              (ps: any) =>
                getBaseCode(ps.subject_code) === baseCode &&
                ps.status === 'UNTAKEN',
            ) ||
            prospectusSubjects.find(
              (ps: any) => getBaseCode(ps.subject_code) === baseCode,
            );
        }
      }

      if (!matchingSubject && sub.descriptive_title) {
        const normTitle = normalizeTitle(sub.descriptive_title);
        if (normTitle.length > 3) {
          matchingSubject =
            prospectusSubjects.find(
              (ps: any) =>
                normalizeTitle(ps.descriptive_title) === normTitle &&
                ps.status === 'UNTAKEN',
            ) ||
            prospectusSubjects.find(
              (ps: any) => normalizeTitle(ps.descriptive_title) === normTitle,
            );
        }
      }

      if (matchingSubject && matchingSubject.status === 'UNTAKEN') {
        await prospectusSubjectModel.update({
          where: { subject_id: matchingSubject.subject_id },
          data: {
            status: 'ENROLLED',
            remarks: `Enrolled in ${academicYear} ${semester}`,
          },
        });
        matchingSubject.status = 'ENROLLED';
        updatedCount++;
      }
    }

    if (updatedCount > 0 && this.cacheService) {
      await this.cacheService.del(`baseline:scholar:${scholar.user_id}`);
      await this.cacheService.del(`baseline:review:${scholar.profile_id}`);
      await this.cacheService.del(`dashboard:scholar:${scholar.user_id}`);
    }
  }

  private async getScholarProfile(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        school_grading_system: true,
        prospectus: { include: { subjects: true } },
      },
    });
    if (!scholar) {
      throw new NotFoundException(
        'Scholar profile not found for current user.',
      );
    }
    return scholar;
  }

  private async getAcademicStandingLock(
    scholarProfileId: number,
    scholar?: any,
  ) {
    const latestFlaggedReport = await this.prisma.gradeReport.findFirst({
      where: {
        scholar_profile_id: scholarProfileId,
        status: 'FLAGGED',
        appeal_status: { not: 'APPROVED' },
      },
      orderBy: { submitted_at: 'desc' },
    });

    // Self-heal legacy 2nd-probation failures that haven't been archived yet
    if (
      latestFlaggedReport &&
      (latestFlaggedReport.appeal_status === 'NONE' ||
        !latestFlaggedReport.appeal_status) &&
      typeof this.prisma.gradeReport?.findFirst === 'function'
    ) {
      const priorResolved = await this.prisma.gradeReport.findFirst({
        where: {
          scholar_profile_id: scholarProfileId,
          report_id: { not: latestFlaggedReport.report_id },
          appeal_status: { in: ['APPROVED', 'DENIED'] },
        },
      });
      if (priorResolved) {
        const archivedAt = scholar?.archived_at ?? new Date();
        const archiveReason = scholar?.archive_reason ?? 'FAILED_SECOND_CHANCE';
        const archiveNotes =
          scholar?.archive_notes ??
          `Failed 2nd-chance probation during ${latestFlaggedReport.academic_year} (${latestFlaggedReport.semester}) with GWA ${Number(latestFlaggedReport.gpa).toFixed(2)}.`;
        const decisionNotes =
          'Second Chance probation exhausted. Automatic archival triggered due to subsequent academic retention deficiency.';

        if (typeof (this.prisma as any).gradeReport?.update === 'function') {
          await (this.prisma as any).gradeReport.update({
            where: { report_id: latestFlaggedReport.report_id },
            data: {
              appeal_status: 'DENIED',
              appeal_reviewed_at: archivedAt,
              appeal_decision_notes: decisionNotes,
            },
          });
        }
        if (typeof (this.prisma as any).scholarProfile?.update === 'function') {
          await (this.prisma as any).scholarProfile.update({
            where: { profile_id: scholarProfileId },
            data: {
              academic_baseline_status: 'DISCONTINUED',
              archived_at: archivedAt,
              archive_reason: archiveReason,
              archive_notes: archiveNotes,
            },
          });
        }
        latestFlaggedReport.appeal_status = 'DENIED';
        if (scholar) {
          scholar.academic_baseline_status = 'DISCONTINUED';
          scholar.archived_at = archivedAt;
          scholar.archive_reason = archiveReason;
          scholar.archive_notes = archiveNotes;
        }
      }
    }

    const isProfileDiscontinued =
      scholar?.academic_baseline_status === 'DISCONTINUED' ||
      Boolean(scholar?.archived_at);

    if (!latestFlaggedReport && !isProfileDiscontinued) {
      return { is_locked: false as const };
    }

    const appealStatus =
      latestFlaggedReport?.appeal_status || (isProfileDiscontinued ? 'DENIED' : 'NONE');
    let reason = 'APPEAL_REQUIRED';
    let message =
      'Your academic standing is under review due to a flagged grade report. Please submit a Second Chance Appeal before enrolling for the next term.';

    if (appealStatus === 'PENDING_GRANTOR') {
      reason = 'APPEAL_PENDING';
      message =
        "Your academic appeal has been submitted and is awaiting the Grantor's verdict. Start-of-term enrollment is locked until your appeal verdict is decided.";
    } else if (appealStatus === 'DENIED' || isProfileDiscontinued) {
      reason = 'DISCONTINUED';
      message =
        scholar?.archive_reason === 'FAILED_SECOND_CHANCE'
          ? 'Your scholarship was archived after exhausting your Second Chance Appeal. You may email the Grantor directly (CC Coordinator) if you wish to request special restoration.'
          : 'Your scholarship agreement has been discontinued following an appeal denial.';
    }

    const [grantorUser, coordinatorUser] =
      reason === 'DISCONTINUED' &&
      typeof (this.prisma as any).user?.findFirst === 'function'
        ? await Promise.all([
            (this.prisma as any).user.findFirst({
              where: { role: 'GRANTOR', is_active: true },
              orderBy: { user_id: 'asc' },
              select: { email: true },
            }),
            (this.prisma as any).user.findFirst({
              where: { role: 'COORDINATOR', is_active: true },
              orderBy: { user_id: 'asc' },
              select: { email: true },
            }),
          ])
        : [null, null];

    return {
      is_locked: true as const,
      reason,
      appeal_status: appealStatus,
      report_id: latestFlaggedReport?.report_id,
      academic_year: latestFlaggedReport?.academic_year,
      semester: latestFlaggedReport?.semester,
      gpa: latestFlaggedReport ? Number(latestFlaggedReport.gpa) : undefined,
      evaluation_flag: latestFlaggedReport?.evaluation_flag,
      message,
      ...(reason === 'DISCONTINUED'
        ? {
            archive_reason: scholar?.archive_reason ?? null,
            scholar_name: scholar
              ? `${scholar.first_name || ''} ${scholar.last_name || ''}`.trim()
              : undefined,
            student_number: scholar?.student_number ?? undefined,
            course_of_study: scholar?.course_of_study ?? undefined,
            grantor_email: grantorUser?.email || 'grantor@viascholar.com',
            coordinator_email:
              coordinatorUser?.email || 'coordinator@viascholar.com',
          }
        : {}),
    };
  }

  // 1. Get current or latest enrollment draft/submission
  async getCurrentEnrollment(
    userId: number,
    academicYear?: string,
    semester?: string,
  ) {
    const scholar = await this.getScholarProfile(userId);

    const academicLock = await this.getAcademicStandingLock(
      scholar.profile_id,
      scholar,
    );

    const whereClause: any = { scholar_profile_id: scholar.profile_id };
    if (academicYear && semester) {
      whereClause.academic_year = academicYear;
      whereClause.semester = semester;
    } else {
      whereClause.status = { not: 'COMPLETED' };
    }

    let enrollment = await this.prisma.termEnrollment.findFirst({
      where: whereClause,
      orderBy: { created_at: 'desc' },
      include: {
        cor_document: true,
        soa_document: true,
        disbursement: true,
      },
    });

    if (
      enrollment &&
      enrollment.status === 'DRAFT' &&
      !(academicYear && semester)
    ) {
      const mergedDraft = await this.consolidateScholarDrafts(
        scholar.profile_id,
      );
      if (mergedDraft) {
        enrollment = mergedDraft as any;
      }
    }

    // If an existing enrollment was APPROVED or SUBMITTED, but the scholar has already confirmed or verified
    // their CCG grades for that term, that semester has ended. Transition it to COMPLETED so the new term enrollment can start.
    if (
      enrollment &&
      (enrollment.status === 'APPROVED' || enrollment.status === 'SUBMITTED')
    ) {
      const confirmedCcg = await this.prisma.scholarDocument.findFirst({
        where: {
          scholar_profile_id: scholar.profile_id,
          document_type: 'CCG',
          status: { in: ['STUDENT_CONFIRMED', 'VERIFIED'] },
        },
      });
      const hasGradeReport = await this.prisma.gradeReport.findFirst({
        where: {
          scholar_profile_id: scholar.profile_id,
          OR: [
            { term_enrollment_id: enrollment.enrollment_id },
            {
              academic_year: enrollment.academic_year,
              semester: enrollment.semester,
            },
          ],
        },
      });

      let hasMatchingCcg = false;
      if (confirmedCcg) {
        const ccgData =
          ((confirmedCcg as any).confirmed_data as Record<string, any>) ||
          ((confirmedCcg as any).extracted_data as Record<string, any>) ||
          null;
        if (ccgData && (ccgData.academic_year || ccgData.semester)) {
          const ayMatches =
            !ccgData.academic_year ||
            !enrollment.academic_year ||
            String(ccgData.academic_year).trim() ===
              String(enrollment.academic_year).trim();
          const semMatches =
            !ccgData.semester ||
            !enrollment.semester ||
            String(ccgData.semester).trim().toLowerCase() ===
              String(enrollment.semester).trim().toLowerCase();
          hasMatchingCcg = ayMatches && semMatches;
        } else if (
          (confirmedCcg as any).uploaded_at &&
          (enrollment as any).created_at
        ) {
          hasMatchingCcg =
            new Date((confirmedCcg as any).uploaded_at).getTime() >=
            new Date((enrollment as any).created_at).getTime();
        } else {
          hasMatchingCcg = true;
        }
      }

      if (hasMatchingCcg || hasGradeReport) {
        await this.prisma.termEnrollment.update({
          where: { enrollment_id: enrollment.enrollment_id },
          data: {
            status: 'COMPLETED',
            coordinator_notes: enrollment.coordinator_notes
              ? `${enrollment.coordinator_notes} | Term concluded with CCG submission.`
              : 'Term concluded with CCG submission. Cleared for next term enrollment.',
          },
        });
        enrollment = null;
      }
    }

    let completedEnrollment = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        status: 'COMPLETED',
      },
      orderBy: { updated_at: 'desc' },
      include: {
        disbursement: true,
      },
    });

    // Self-heal an enrollment that was prematurely auto-completed before Coordinator review
    if (
      !enrollment &&
      completedEnrollment &&
      (completedEnrollment as any).reviewed_by_employee_id === null &&
      (completedEnrollment as any).disbursement_id === null &&
      typeof (completedEnrollment as any).coordinator_notes === 'string' &&
      (completedEnrollment as any).coordinator_notes.includes(
        'Term concluded with CCG submission.',
      )
    ) {
      const hasReportForCompleted = await this.prisma.gradeReport.findFirst({
        where: {
          scholar_profile_id: scholar.profile_id,
          OR: [
            { term_enrollment_id: completedEnrollment.enrollment_id },
            {
              academic_year: completedEnrollment.academic_year,
              semester: completedEnrollment.semester,
            },
          ],
        },
      });
      if (!hasReportForCompleted) {
        enrollment = await this.prisma.termEnrollment.update({
          where: { enrollment_id: completedEnrollment.enrollment_id },
          data: {
            status: 'PENDING_REVIEW',
            coordinator_notes: null,
          },
          include: {
            cor_document: true,
            soa_document: true,
            disbursement: true,
          },
        });
        completedEnrollment = await this.prisma.termEnrollment.findFirst({
          where: {
            scholar_profile_id: scholar.profile_id,
            status: 'COMPLETED',
          },
          orderBy: { updated_at: 'desc' },
          include: {
            disbursement: true,
          },
        });
      }
    }

    if (
      enrollment &&
      (enrollment.status === 'PENDING_REVIEW' ||
        enrollment.status === 'APPROVED')
    ) {
      await this.syncEnrolledSubjectsToProspectus(
        scholar,
        (enrollment.enrolled_subjects as any[]) || [],
        enrollment.academic_year,
        enrollment.semester,
      );
    }

    return {
      scholar,
      enrollment,
      completed_previous_enrollment: completedEnrollment,
      prospectus_frozen: scholar.prospectus?.is_frozen ?? false,
      academic_lock: academicLock,
    };
  }

  private async consolidateScholarDrafts(
    scholarProfileId: number,
    preferredAy?: string,
    preferredSem?: string,
  ) {
    const drafts = await this.prisma.termEnrollment.findMany({
      where: {
        scholar_profile_id: scholarProfileId,
        status: 'DRAFT',
      },
      orderBy: { updated_at: 'desc' },
    });

    if (!Array.isArray(drafts) || drafts.length <= 1) {
      return null;
    }

    const targetDraft =
      (preferredAy &&
        preferredSem &&
        drafts.find(
          (d) =>
            d.academic_year === preferredAy && d.semester === preferredSem,
        )) ||
      drafts.find(
        (d) => d.academic_year && d.academic_year !== '2026-2027',
      ) ||
      drafts.find((d) => d.cor_document_id != null) ||
      drafts[0];

    const otherDrafts = drafts.filter(
      (d) => d.enrollment_id !== targetDraft.enrollment_id,
    );

    const updateData: Record<string, any> = {};

    if (!targetDraft.cor_document_id) {
      const corDonor = otherDrafts.find((d) => d.cor_document_id != null);
      if (corDonor) {
        updateData.cor_document_id = corDonor.cor_document_id;
        updateData.enrolled_subjects = corDonor.enrolled_subjects ?? [];
        updateData.total_units = corDonor.total_units ?? 0;
        if (corDonor.year_level) {
          updateData.year_level = corDonor.year_level;
        }
        if (
          (!Array.isArray(targetDraft.audit_flags) ||
            (targetDraft.audit_flags as any[]).length === 0) &&
          corDonor.audit_flags
        ) {
          updateData.audit_flags = corDonor.audit_flags;
        }
      }
    }

    if (!targetDraft.soa_document_id) {
      const soaDonor = otherDrafts.find((d) => d.soa_document_id != null);
      if (soaDonor) {
        updateData.soa_document_id = soaDonor.soa_document_id;
        updateData.total_assessment = soaDonor.total_assessment ?? 0;
        updateData.assessment_date = soaDonor.assessment_date ?? null;
        updateData.billing_breakdown = soaDonor.billing_breakdown ?? {};
      }
    }

    if (targetDraft.academic_year === '2026-2027') {
      const termDonor = otherDrafts.find(
        (d) => d.academic_year && d.academic_year !== '2026-2027',
      );
      if (termDonor) {
        updateData.academic_year = termDonor.academic_year;
        updateData.semester = termDonor.semester;
      }
    }

    for (const od of otherDrafts) {
      await this.prisma.termEnrollment.delete({
        where: { enrollment_id: od.enrollment_id },
      });
    }

    return this.prisma.termEnrollment.update({
      where: { enrollment_id: targetDraft.enrollment_id },
      data: updateData,
      include: {
        cor_document: true,
        soa_document: true,
        disbursement: true,
      },
    });
  }

  // 2. Upload and parse COR document
  async uploadAndParseCor(userId: number, file: Express.Multer.File) {
    const scholar = await this.getScholarProfile(userId);
    const lock = await this.getAcademicStandingLock(scholar.profile_id);
    if (lock.is_locked) {
      throw new BadRequestException(lock.message);
    }
    if (!file) throw new BadRequestException('No COR file uploaded.');

    // Concurrently upload to Cloudinary and parse via OCR
    const uploadPromise = this.cloudinaryService.uploadDocument(
      file,
      'viascholar/enrollment/cor',
    );

    const [uploadRes, extractedData] = await Promise.all([
      uploadPromise,
      this.enrollmentOcrService.parseCor({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
      }),
    ]);

    const ay = extractedData.academic_year || '2026-2027';
    const sem = extractedData.semester || '1st Semester';
    const yr = extractedData.year_level || scholar.current_year_level || 1;

    // Clean up old draft COR document if re-uploading
    const existingDraft = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        status: 'DRAFT',
      },
    });
    if (existingDraft?.cor_document_id) {
      const oldDoc = await this.prisma.scholarDocument.findUnique({
        where: { document_id: existingDraft.cor_document_id },
      });
      if (oldDoc && oldDoc.status !== 'VERIFIED') {
        await this.prisma.scholarDocument
          .delete({
            where: { document_id: existingDraft.cor_document_id },
          })
          .catch(() => {});
      }
    }

    // Check for any other active DRAFT rows with a different academic_year/semester
    // (e.g. an Assessment/SOA uploaded first that defaulted to a different term)
    const allDrafts = await this.prisma.termEnrollment.findMany({
      where: {
        scholar_profile_id: scholar.profile_id,
        status: 'DRAFT',
      },
      orderBy: { updated_at: 'desc' },
    });
    const mismatchedDrafts = (Array.isArray(allDrafts) ? allDrafts : []).filter(
      (d) => d.academic_year !== ay || d.semester !== sem,
    );
    const carriedSoaDraft = !existingDraft?.soa_document_id
      ? mismatchedDrafts.find((d) => d.soa_document_id != null)
      : undefined;

    for (const md of mismatchedDrafts) {
      if (
        md.cor_document_id &&
        md.cor_document_id !== existingDraft?.cor_document_id &&
        md.cor_document_id !== carriedSoaDraft?.soa_document_id
      ) {
        const oldDoc = await this.prisma.scholarDocument.findUnique({
          where: { document_id: md.cor_document_id },
        });
        if (oldDoc && oldDoc.status !== 'VERIFIED') {
          await this.prisma.scholarDocument
            .delete({
              where: { document_id: md.cor_document_id },
            })
            .catch(() => {});
        }
      }
      await this.prisma.termEnrollment.delete({
        where: { enrollment_id: md.enrollment_id },
      });
    }

    // Save ScholarDocument
    const doc = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: 'CERTIFICATE_OF_REGISTRATION',
        label: `COR - ${extractedData.academic_year || 'Current'} ${extractedData.semester || ''}`,
        file_name: file.originalname,
        file_url: uploadRes.secure_url,
        file_size: `${(file.size / 1024).toFixed(1)} KB`,
        file_type: file.mimetype.includes('pdf') ? 'pdf' : 'image',
        status: 'PASSED_PRECHECK',
        extracted_data: extractedData as any,
      },
    });

    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      extractedData.subjects || [],
      {
        corStudentId: extractedData.student_number,
        corStudentName: extractedData.student_name,
        academicYear: ay,
        semester: sem,
      },
    );

    const carriedSoaFields = carriedSoaDraft
      ? {
          soa_document_id: carriedSoaDraft.soa_document_id,
          total_assessment: carriedSoaDraft.total_assessment || 0,
          assessment_date: carriedSoaDraft.assessment_date || null,
          billing_breakdown: carriedSoaDraft.billing_breakdown as any,
        }
      : {};

    const draft = await this.prisma.termEnrollment.upsert({
      where: {
        scholar_profile_id_academic_year_semester: {
          scholar_profile_id: scholar.profile_id,
          academic_year: ay,
          semester: sem,
        },
      },
      create: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        year_level: yr,
        is_consolidated: false,
        cor_document_id: doc.document_id,
        total_units: extractedData.total_units || 0,
        total_assessment: 0,
        status: 'DRAFT',
        audit_flags: auditResult.flags as any,
        enrolled_subjects: extractedData.subjects as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
        ...carriedSoaFields,
      },
      update: {
        cor_document_id: doc.document_id,
        enrolled_subjects: extractedData.subjects as any,
        total_units: extractedData.total_units || 0,
        year_level: yr,
        audit_flags: auditResult.flags as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
        ...carriedSoaFields,
      },
      include: {
        cor_document: true,
        soa_document: true,
      },
    });

    return {
      document_id: doc.document_id,
      file_url: uploadRes.secure_url,
      extracted_data: extractedData,
      draft_enrollment: draft,
      audit_result: auditResult,
    };
  }

  // 3. Upload and parse SOA document
  async uploadAndParseSoa(userId: number, file: Express.Multer.File) {
    const scholar = await this.getScholarProfile(userId);
    const lock = await this.getAcademicStandingLock(scholar.profile_id);
    if (lock.is_locked) {
      throw new BadRequestException(lock.message);
    }
    if (!file) throw new BadRequestException('No SOA file uploaded.');

    // Concurrently upload to Cloudinary and parse via OCR
    const uploadPromise = this.cloudinaryService.uploadDocument(
      file,
      'viascholar/enrollment/soa',
    );

    const [uploadRes, extractedData] = await Promise.all([
      uploadPromise,
      this.enrollmentOcrService.parseSoa({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
      }),
    ]);

    let ay = extractedData.academic_year || '2026-2027';
    let sem = extractedData.semester || '1st Semester';
    let yr = scholar.current_year_level || 1;

    const allDrafts = await this.prisma.termEnrollment.findMany({
      where: {
        scholar_profile_id: scholar.profile_id,
        status: 'DRAFT',
      },
      orderBy: { updated_at: 'desc' },
    });
    const activeDrafts = Array.isArray(allDrafts) ? allDrafts : [];
    const corDonorDraft = activeDrafts.find((d) => d.cor_document_id != null);

    if (
      corDonorDraft &&
      (!extractedData.academic_year ||
        (ay === '2026-2027' && corDonorDraft.academic_year !== '2026-2027'))
    ) {
      ay = corDonorDraft.academic_year;
      sem = corDonorDraft.semester;
      yr = corDonorDraft.year_level || yr;
    }

    // Clean up old draft SOA document if re-uploading
    const existingDraft = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        status: 'DRAFT',
      },
    });
    if (
      existingDraft?.soa_document_id &&
      existingDraft.soa_document_id !== existingDraft.cor_document_id
    ) {
      const oldDoc = await this.prisma.scholarDocument.findUnique({
        where: { document_id: existingDraft.soa_document_id },
      });
      if (oldDoc && oldDoc.status !== 'VERIFIED') {
        await this.prisma.scholarDocument
          .delete({
            where: { document_id: existingDraft.soa_document_id },
          })
          .catch(() => {});
      }
    }

    const mismatchedDrafts = activeDrafts.filter(
      (d) => d.academic_year !== ay || d.semester !== sem,
    );
    const carriedCorDraft = !existingDraft?.cor_document_id
      ? mismatchedDrafts.find((d) => d.cor_document_id != null)
      : undefined;

    for (const md of mismatchedDrafts) {
      if (
        md.soa_document_id &&
        md.soa_document_id !== md.cor_document_id &&
        md.soa_document_id !== existingDraft?.soa_document_id &&
        md.soa_document_id !== carriedCorDraft?.cor_document_id
      ) {
        const oldDoc = await this.prisma.scholarDocument.findUnique({
          where: { document_id: md.soa_document_id },
        });
        if (oldDoc && oldDoc.status !== 'VERIFIED') {
          await this.prisma.scholarDocument
            .delete({
              where: { document_id: md.soa_document_id },
            })
            .catch(() => {});
        }
      }
      await this.prisma.termEnrollment.delete({
        where: { enrollment_id: md.enrollment_id },
      });
    }

    const doc = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: 'STATEMENT_OF_ACCOUNT',
        label: `SOA - ${extractedData.academic_year || 'Current'} ${extractedData.semester || ''}`,
        file_name: file.originalname,
        file_url: uploadRes.secure_url,
        file_size: `${(file.size / 1024).toFixed(1)} KB`,
        file_type: file.mimetype.includes('pdf') ? 'pdf' : 'image',
        status: 'PASSED_PRECHECK',
        extracted_data: extractedData as any,
      },
    });

    const billingBreakdown = {
      tuition_fee: extractedData.tuition_fee,
      lab_fees: extractedData.lab_fees,
      misc_fees: extractedData.misc_fees,
      other_fees: extractedData.other_fees,
      previous_balance: extractedData.previous_balance,
      discounts: extractedData.discounts,
      net_balance_due:
        extractedData.net_balance_due ?? extractedData.total_assessment,
    };

    const existingEnrollment = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
      },
    });
    const subjectsToAudit =
      (existingEnrollment?.enrolled_subjects as any) ||
      (carriedCorDraft?.enrolled_subjects as any) ||
      [];

    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      subjectsToAudit,
      {
        soaStudentId: extractedData.student_number,
        soaStudentName: extractedData.student_name,
        academicYear: ay,
        semester: sem,
      },
    );

    const carriedCorFields = carriedCorDraft
      ? {
          cor_document_id: carriedCorDraft.cor_document_id,
          enrolled_subjects: (carriedCorDraft.enrolled_subjects ?? []) as any,
          total_units: carriedCorDraft.total_units || 0,
          year_level: carriedCorDraft.year_level || yr,
        }
      : {};

    const draft = await this.prisma.termEnrollment.upsert({
      where: {
        scholar_profile_id_academic_year_semester: {
          scholar_profile_id: scholar.profile_id,
          academic_year: ay,
          semester: sem,
        },
      },
      create: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        year_level: yr,
        is_consolidated: false,
        soa_document_id: doc.document_id,
        total_units: 0,
        total_assessment: extractedData.total_assessment || 0,
        assessment_date: extractedData.assessment_date
          ? new Date(extractedData.assessment_date)
          : null,
        status: 'DRAFT',
        audit_flags: auditResult.flags as any,
        billing_breakdown: billingBreakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
        ...carriedCorFields,
      },
      update: {
        soa_document_id: doc.document_id,
        total_assessment: extractedData.total_assessment || 0,
        assessment_date: extractedData.assessment_date
          ? new Date(extractedData.assessment_date)
          : null,
        audit_flags: auditResult.flags as any,
        billing_breakdown: billingBreakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
        ...carriedCorFields,
      },
      include: {
        cor_document: true,
        soa_document: true,
      },
    });

    return {
      document_id: doc.document_id,
      file_url: uploadRes.secure_url,
      extracted_data: extractedData,
      draft_enrollment: draft,
      audit_result: auditResult,
    };
  }

  // 4. Upload and parse Consolidated COR+SOA document
  async uploadAndParseConsolidated(userId: number, file: Express.Multer.File) {
    const scholar = await this.getScholarProfile(userId);
    const lock = await this.getAcademicStandingLock(scholar.profile_id);
    if (lock.is_locked) {
      throw new BadRequestException(lock.message);
    }
    if (!file) throw new BadRequestException('No consolidated file uploaded.');

    // Concurrently upload to Cloudinary and parse via OCR
    const uploadPromise = this.cloudinaryService.uploadDocument(
      file,
      'viascholar/enrollment/consolidated',
    );

    const [uploadRes, extractedData] = await Promise.all([
      uploadPromise,
      this.enrollmentOcrService.parseConsolidated({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
      }),
    ]);

    const ay = extractedData.academic_year || '2026-2027';
    const sem = extractedData.semester || '1st Semester';
    const yr = extractedData.year_level || scholar.current_year_level || 1;

    // Clean up old draft consolidated document if re-uploading
    const existingDraft = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        status: 'DRAFT',
      },
    });
    if (existingDraft?.cor_document_id) {
      const oldDoc = await this.prisma.scholarDocument.findUnique({
        where: { document_id: existingDraft.cor_document_id },
      });
      if (oldDoc && oldDoc.status !== 'VERIFIED') {
        await this.prisma.scholarDocument
          .delete({
            where: { document_id: existingDraft.cor_document_id },
          })
          .catch(() => {});
      }
    }

    const doc = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: 'CONSOLIDATED_MATRICULATION',
        label: `Consolidated COR/SOA - ${extractedData.academic_year || 'Current'} ${extractedData.semester || ''}`,
        file_name: file.originalname,
        file_url: uploadRes.secure_url,
        file_size: `${(file.size / 1024).toFixed(1)} KB`,
        file_type: file.mimetype.includes('pdf') ? 'pdf' : 'image',
        status: 'PASSED_PRECHECK',
        extracted_data: extractedData as any,
      },
    });

    const billingBreakdown = {
      tuition_fee: extractedData.tuition_fee,
      lab_fees: extractedData.lab_fees,
      misc_fees: extractedData.misc_fees,
      other_fees: extractedData.other_fees,
      previous_balance: extractedData.previous_balance,
      discounts: extractedData.discounts,
      net_balance_due:
        extractedData.net_balance_due ?? extractedData.total_assessment,
    };

    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      extractedData.subjects || [],
      {
        corStudentId: extractedData.student_number,
        corStudentName: extractedData.student_name,
        soaStudentId: extractedData.student_number,
        soaStudentName: extractedData.student_name,
        academicYear: ay,
        semester: sem,
      },
    );

    const draft = await this.prisma.termEnrollment.upsert({
      where: {
        scholar_profile_id_academic_year_semester: {
          scholar_profile_id: scholar.profile_id,
          academic_year: ay,
          semester: sem,
        },
      },
      create: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        year_level: yr,
        is_consolidated: true,
        cor_document_id: doc.document_id,
        soa_document_id: doc.document_id,
        total_units: extractedData.total_units || 0,
        total_assessment: extractedData.total_assessment || 0,
        assessment_date: extractedData.assessment_date
          ? new Date(extractedData.assessment_date)
          : null,
        status: 'DRAFT',
        audit_flags: auditResult.flags as any,
        enrolled_subjects: extractedData.subjects as any,
        billing_breakdown: billingBreakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
      },
      update: {
        is_consolidated: true,
        cor_document_id: doc.document_id,
        soa_document_id: doc.document_id,
        total_units: extractedData.total_units || 0,
        total_assessment: extractedData.total_assessment || 0,
        assessment_date: extractedData.assessment_date
          ? new Date(extractedData.assessment_date)
          : null,
        audit_flags: auditResult.flags as any,
        enrolled_subjects: extractedData.subjects as any,
        billing_breakdown: billingBreakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
      },
      include: {
        cor_document: true,
        soa_document: true,
      },
    });

    return {
      document_id: doc.document_id,
      file_url: uploadRes.secure_url,
      extracted_data: extractedData,
      draft_enrollment: draft,
      audit_result: auditResult,
    };
  }

  private async upsertEnrollment(
    scholarProfileId: number,
    dto: SubmitEnrollmentDto,
    status: 'DRAFT' | 'PENDING_REVIEW',
    auditResult: any,
  ) {
    const upserted = await this.prisma.termEnrollment.upsert({
      where: {
        scholar_profile_id_academic_year_semester: {
          scholar_profile_id: scholarProfileId,
          academic_year: dto.academic_year,
          semester: dto.semester,
        },
      },
      create: {
        scholar_profile_id: scholarProfileId,
        academic_year: dto.academic_year,
        semester: dto.semester,
        year_level: dto.year_level,
        is_consolidated: dto.is_consolidated ?? false,
        cor_document_id: dto.cor_document_id,
        soa_document_id: dto.soa_document_id,
        total_units: dto.total_units,
        total_assessment: dto.total_assessment,
        assessment_date: dto.assessment_date
          ? new Date(dto.assessment_date)
          : null,
        status,
        audit_flags: auditResult.flags,
        enrolled_subjects: dto.enrolled_subjects as any,
        billing_breakdown: dto.billing_breakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation,
      },
      update: {
        year_level: dto.year_level,
        is_consolidated: dto.is_consolidated ?? false,
        cor_document_id: dto.cor_document_id,
        soa_document_id: dto.soa_document_id,
        total_units: dto.total_units,
        total_assessment: dto.total_assessment,
        assessment_date: dto.assessment_date
          ? new Date(dto.assessment_date)
          : null,
        status,
        audit_flags: auditResult.flags,
        enrolled_subjects: dto.enrolled_subjects as any,
        billing_breakdown: dto.billing_breakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation,
      },
      include: {
        cor_document: true,
        soa_document: true,
      },
    });

    const otherDrafts = await this.prisma.termEnrollment.findMany({
      where: {
        scholar_profile_id: scholarProfileId,
        status: 'DRAFT',
      },
    });
    if (Array.isArray(otherDrafts)) {
      for (const od of otherDrafts) {
        if (
          od.academic_year !== dto.academic_year ||
          od.semester !== dto.semester
        ) {
          await this.prisma.termEnrollment.delete({
            where: { enrollment_id: od.enrollment_id },
          });
        }
      }
    }

    return upserted;
  }

  // 5. Save or update draft enrollment without submitting
  async saveDraft(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    const lock = await this.getAcademicStandingLock(scholar.profile_id);
    if (lock.is_locked) {
      throw new BadRequestException(lock.message);
    }
    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      dto.enrolled_subjects,
      { academicYear: dto.academic_year, semester: dto.semester },
    );
    const draft = await this.upsertEnrollment(
      scholar.profile_id,
      dto,
      'DRAFT',
      auditResult,
    );
    return {
      message: 'Draft enrollment saved successfully.',
      enrollment: draft,
      audit_result: auditResult,
    };
  }

  // 6. Discard draft enrollment
  async discardDraft(userId: number, academicYear?: string, semester?: string) {
    const scholar = await this.getScholarProfile(userId);
    const whereClause: any = {
      scholar_profile_id: scholar.profile_id,
      status: 'DRAFT',
    };
    if (academicYear && semester) {
      whereClause.academic_year = academicYear;
      whereClause.semester = semester;
    }

    const drafts = await this.prisma.termEnrollment.findMany({
      where: whereClause,
      select: { cor_document_id: true, soa_document_id: true },
    });

    const docIdsToDelete: number[] = [];
    for (const d of drafts) {
      if (d.cor_document_id) docIdsToDelete.push(d.cor_document_id);
      if (d.soa_document_id && d.soa_document_id !== d.cor_document_id) {
        docIdsToDelete.push(d.soa_document_id);
      }
    }

    const deleted = await this.prisma.termEnrollment.deleteMany({
      where: whereClause,
    });

    if (docIdsToDelete.length > 0) {
      await this.prisma.scholarDocument
        .deleteMany({
          where: {
            document_id: { in: docIdsToDelete },
            status: { not: 'VERIFIED' },
          },
        })
        .catch(() => {});
    }

    return {
      message: 'Draft enrollment cleared successfully.',
      count: deleted.count,
    };
  }

  // 6b. Clear a specific document from draft and update/reset draft state
  async clearDraftDocument(
    userId: number,
    docType: 'cor' | 'soa' | 'consolidated',
  ) {
    const scholar = await this.getScholarProfile(userId);
    const consolidatedDraft = await this.consolidateScholarDrafts(
      scholar.profile_id,
    );
    const draft =
      consolidatedDraft ||
      (await this.prisma.termEnrollment.findFirst({
        where: {
          scholar_profile_id: scholar.profile_id,
          status: 'DRAFT',
        },
        orderBy: { created_at: 'desc' },
      }));

    if (!draft) {
      return { success: true, message: 'No active draft found to clear.' };
    }

    if (docType === 'cor') {
      if (draft.cor_document_id) {
        await this.prisma.scholarDocument
          .delete({
            where: { document_id: draft.cor_document_id },
          })
          .catch(() => {});
      }

      // If SOA is also absent or same as COR, delete the draft entirely
      if (
        !draft.soa_document_id ||
        draft.soa_document_id === draft.cor_document_id
      ) {
        await this.prisma.termEnrollment.delete({
          where: { enrollment_id: draft.enrollment_id },
        });
        return { success: true, message: 'Enrollment draft reset.' };
      } else {
        await this.prisma.termEnrollment.update({
          where: { enrollment_id: draft.enrollment_id },
          data: {
            cor_document_id: null,
            enrolled_subjects: [],
            total_units: 0,
            audit_flags: [],
          },
        });
        return {
          success: true,
          message: 'Proof of subjects removed from draft.',
        };
      }
    } else if (docType === 'soa') {
      if (draft.soa_document_id) {
        await this.prisma.scholarDocument
          .delete({
            where: { document_id: draft.soa_document_id },
          })
          .catch(() => {});
      }

      // If COR is also absent or same as SOA, delete the draft entirely
      if (
        !draft.cor_document_id ||
        draft.cor_document_id === draft.soa_document_id
      ) {
        await this.prisma.termEnrollment.delete({
          where: { enrollment_id: draft.enrollment_id },
        });
        return { success: true, message: 'Enrollment draft reset.' };
      } else {
        await this.prisma.termEnrollment.update({
          where: { enrollment_id: draft.enrollment_id },
          data: {
            soa_document_id: null,
            total_assessment: 0,
            assessment_date: null,
            billing_breakdown: {},
          },
        });
        return {
          success: true,
          message: 'Proof of billing removed from draft.',
        };
      }
    } else if (docType === 'consolidated') {
      const docIds = [draft.cor_document_id, draft.soa_document_id].filter(
        Boolean,
      ) as number[];
      if (docIds.length > 0) {
        await this.prisma.scholarDocument
          .deleteMany({
            where: { document_id: { in: docIds } },
          })
          .catch(() => {});
      }
      await this.prisma.termEnrollment.delete({
        where: { enrollment_id: draft.enrollment_id },
      });
      return {
        success: true,
        message: 'Consolidated document removed and draft reset.',
      };
    }

    return { success: true, message: 'Document cleared.' };
  }

  // 7. Pre-audit calculation before final submission
  async runPreAudit(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    return this.auditEngineService.runAudit(
      scholar.profile_id,
      dto.enrolled_subjects,
      {
        academicYear: dto.academic_year,
        semester: dto.semester,
      },
    );
  }

  // 8. Submit final term enrollment for review
  async submitEnrollment(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    const lock = await this.getAcademicStandingLock(scholar.profile_id);
    if (lock.is_locked) {
      throw new BadRequestException(lock.message);
    }
    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      dto.enrolled_subjects,
      { academicYear: dto.academic_year, semester: dto.semester },
    );
    const enrollment = await this.upsertEnrollment(
      scholar.profile_id,
      dto,
      'PENDING_REVIEW',
      auditResult,
    );

    await this.syncEnrolledSubjectsToProspectus(
      scholar,
      dto.enrolled_subjects || [],
      dto.academic_year,
      dto.semester,
      auditResult.subjects_audit,
    );

    await this.auditService.log(
      userId,
      'SUBMIT_TERM_ENROLLMENT',
      `Submitted term enrollment for ${dto.academic_year} ${dto.semester} with total assessment PHP ${dto.total_assessment}`,
    );

    this.eventsGateway.emitToStaff('enrollment:submitted_for_review', {
      enrollment_id: enrollment.enrollment_id,
      scholar_id: scholar.profile_id,
      scholar_name: `${scholar.first_name} ${scholar.last_name}`,
      academic_year: dto.academic_year,
      semester: dto.semester,
      total_assessment: dto.total_assessment,
      audit_flags: auditResult.flags,
    });

    return {
      message: 'Term enrollment submitted successfully for coordinator review.',
      enrollment,
      audit_result: auditResult,
    };
  }
}
