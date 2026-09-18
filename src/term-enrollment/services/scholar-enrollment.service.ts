import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EnrollmentOcrService } from './enrollment-ocr.service.js';
import { EnrollmentAuditEngineService } from './enrollment-audit-engine.service.js';
import { SubmitEnrollmentDto } from '../dto/submit-enrollment.dto.js';
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
  ) {}

  private async getScholarProfile(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        school_grading_system: true,
        prospectus: { include: { subjects: true } },
      },
    });
    if (!scholar) {
      throw new NotFoundException('Scholar profile not found for current user.');
    }
    return scholar;
  }

  // 1. Get current or latest enrollment draft/submission
  async getCurrentEnrollment(userId: number, academicYear?: string, semester?: string) {
    const scholar = await this.getScholarProfile(userId);

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

    // If an existing enrollment was APPROVED or SUBMITTED, but the scholar has already confirmed or verified
    // their CCG grades, that semester has ended. Transition it to COMPLETED so the new term enrollment can start.
    if (enrollment && (enrollment.status === 'APPROVED' || enrollment.status === 'SUBMITTED' || enrollment.status === 'PENDING_REVIEW')) {
      const hasConfirmedCcg = await this.prisma.scholarDocument.findFirst({
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
            { academic_year: enrollment.academic_year, semester: enrollment.semester },
          ],
        },
      });

      if (hasConfirmedCcg || hasGradeReport) {
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

    const completedEnrollment = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        status: 'COMPLETED',
      },
      orderBy: { updated_at: 'desc' },
      include: {
        disbursement: true,
      },
    });

    return {
      scholar,
      enrollment,
      completed_previous_enrollment: completedEnrollment,
      prospectus_frozen: scholar.prospectus?.is_frozen ?? false,
    };
  }

  // 2. Upload and parse COR document
  async uploadAndParseCor(userId: number, file: Express.Multer.File) {
    const scholar = await this.getScholarProfile(userId);
    if (!file) throw new BadRequestException('No COR file uploaded.');

    // Upload to Cloudinary
    const uploadRes = await this.cloudinaryService.uploadDocument(file, 'viascholar/enrollment/cor');

    // Parse via OCR
    const extractedData = await this.enrollmentOcrService.parseCor({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });

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
        await this.prisma.scholarDocument.delete({
          where: { document_id: existingDraft.cor_document_id },
        }).catch(() => {});
      }
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
      (extractedData.subjects || []) as any,
      {
        corStudentId: extractedData.student_number,
        corStudentName: extractedData.student_name,
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
        is_consolidated: false,
        cor_document_id: doc.document_id,
        total_units: extractedData.total_units || 0,
        total_assessment: 0,
        status: 'DRAFT',
        audit_flags: auditResult.flags as any,
        enrolled_subjects: extractedData.subjects as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
      },
      update: {
        cor_document_id: doc.document_id,
        enrolled_subjects: extractedData.subjects as any,
        total_units: extractedData.total_units || 0,
        year_level: yr,
        audit_flags: auditResult.flags as any,
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

  // 3. Upload and parse SOA document
  async uploadAndParseSoa(userId: number, file: Express.Multer.File) {
    const scholar = await this.getScholarProfile(userId);
    if (!file) throw new BadRequestException('No SOA file uploaded.');

    const uploadRes = await this.cloudinaryService.uploadDocument(file, 'viascholar/enrollment/soa');

    const extractedData = await this.enrollmentOcrService.parseSoa({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });

    const ay = extractedData.academic_year || '2026-2027';
    const sem = extractedData.semester || '1st Semester';
    const yr = scholar.current_year_level || 1;

    // Clean up old draft SOA document if re-uploading
    const existingDraft = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
        status: 'DRAFT',
      },
    });
    if (existingDraft?.soa_document_id && existingDraft.soa_document_id !== existingDraft.cor_document_id) {
      const oldDoc = await this.prisma.scholarDocument.findUnique({
        where: { document_id: existingDraft.soa_document_id },
      });
      if (oldDoc && oldDoc.status !== 'VERIFIED') {
        await this.prisma.scholarDocument.delete({
          where: { document_id: existingDraft.soa_document_id },
        }).catch(() => {});
      }
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
      net_balance_due: extractedData.net_balance_due ?? extractedData.total_assessment,
    };

    const existingEnrollment = await this.prisma.termEnrollment.findFirst({
      where: {
        scholar_profile_id: scholar.profile_id,
        academic_year: ay,
        semester: sem,
      },
    });
    const subjectsToAudit = (existingEnrollment?.enrolled_subjects as any) || [];

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
        assessment_date: extractedData.assessment_date ? new Date(extractedData.assessment_date) : null,
        status: 'DRAFT',
        audit_flags: auditResult.flags as any,
        billing_breakdown: billingBreakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
      },
      update: {
        soa_document_id: doc.document_id,
        total_assessment: extractedData.total_assessment || 0,
        assessment_date: extractedData.assessment_date ? new Date(extractedData.assessment_date) : null,
        audit_flags: auditResult.flags as any,
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

  // 4. Upload and parse Consolidated COR+SOA document
  async uploadAndParseConsolidated(userId: number, file: Express.Multer.File) {
    const scholar = await this.getScholarProfile(userId);
    if (!file) throw new BadRequestException('No consolidated file uploaded.');

    const uploadRes = await this.cloudinaryService.uploadDocument(file, 'viascholar/enrollment/consolidated');

    const extractedData = await this.enrollmentOcrService.parseConsolidated({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });

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
        await this.prisma.scholarDocument.delete({
          where: { document_id: existingDraft.cor_document_id },
        }).catch(() => {});
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
      net_balance_due: extractedData.net_balance_due ?? extractedData.total_assessment,
    };

    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      (extractedData.subjects || []) as any,
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
        assessment_date: extractedData.assessment_date ? new Date(extractedData.assessment_date) : null,
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
        assessment_date: extractedData.assessment_date ? new Date(extractedData.assessment_date) : null,
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
    return this.prisma.termEnrollment.upsert({
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
        assessment_date: dto.assessment_date ? new Date(dto.assessment_date) : null,
        status,
        audit_flags: auditResult.flags as any,
        enrolled_subjects: dto.enrolled_subjects as any,
        billing_breakdown: dto.billing_breakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
      },
      update: {
        year_level: dto.year_level,
        is_consolidated: dto.is_consolidated ?? false,
        cor_document_id: dto.cor_document_id,
        soa_document_id: dto.soa_document_id,
        total_units: dto.total_units,
        total_assessment: dto.total_assessment,
        assessment_date: dto.assessment_date ? new Date(dto.assessment_date) : null,
        status,
        audit_flags: auditResult.flags as any,
        enrolled_subjects: dto.enrolled_subjects as any,
        billing_breakdown: dto.billing_breakdown as any,
        cross_doc_reconciliation: auditResult.cross_doc_reconciliation as any,
      },
      include: {
        cor_document: true,
        soa_document: true,
      },
    });
  }

  // 5. Save or update draft enrollment without submitting
  async saveDraft(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      dto.enrolled_subjects,
      { academicYear: dto.academic_year, semester: dto.semester },
    );
    const draft = await this.upsertEnrollment(scholar.profile_id, dto, 'DRAFT', auditResult);
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

  // 7. Pre-audit calculation before final submission
  async runPreAudit(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    return this.auditEngineService.runAudit(scholar.profile_id, dto.enrolled_subjects, {
      academicYear: dto.academic_year,
      semester: dto.semester,
    });
  }

  // 8. Submit final term enrollment for review
  async submitEnrollment(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      dto.enrolled_subjects,
      { academicYear: dto.academic_year, semester: dto.semester },
    );
    const enrollment = await this.upsertEnrollment(scholar.profile_id, dto, 'PENDING_REVIEW', auditResult);

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
