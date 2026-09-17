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
    }

    const enrollment = await this.prisma.termEnrollment.findFirst({
      where: whereClause,
      orderBy: { created_at: 'desc' },
      include: {
        cor_document: true,
        soa_document: true,
        disbursement: true,
      },
    });

    return {
      scholar,
      enrollment,
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

    return {
      document_id: doc.document_id,
      file_url: uploadRes.secure_url,
      extracted_data: extractedData,
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

    return {
      document_id: doc.document_id,
      file_url: uploadRes.secure_url,
      extracted_data: extractedData,
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

    return {
      document_id: doc.document_id,
      file_url: uploadRes.secure_url,
      extracted_data: extractedData,
    };
  }

  // 5. Pre-audit calculation before final submission
  async runPreAudit(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);
    return this.auditEngineService.runAudit(scholar.profile_id, dto.enrolled_subjects, {
      academicYear: dto.academic_year,
      semester: dto.semester,
    });
  }

  // 6. Submit final term enrollment for review
  async submitEnrollment(userId: number, dto: SubmitEnrollmentDto) {
    const scholar = await this.getScholarProfile(userId);

    // Run audit engine
    const auditResult = await this.auditEngineService.runAudit(
      scholar.profile_id,
      dto.enrolled_subjects,
      {
        academicYear: dto.academic_year,
        semester: dto.semester,
      },
    );

    // Upsert TermEnrollment record
    const enrollment = await this.prisma.termEnrollment.upsert({
      where: {
        scholar_profile_id_academic_year_semester: {
          scholar_profile_id: scholar.profile_id,
          academic_year: dto.academic_year,
          semester: dto.semester,
        },
      },
      create: {
        scholar_profile_id: scholar.profile_id,
        academic_year: dto.academic_year,
        semester: dto.semester,
        year_level: dto.year_level,
        is_consolidated: dto.is_consolidated ?? false,
        cor_document_id: dto.cor_document_id,
        soa_document_id: dto.soa_document_id,
        total_units: dto.total_units,
        total_assessment: dto.total_assessment,
        assessment_date: dto.assessment_date ? new Date(dto.assessment_date) : null,
        status: 'PENDING_REVIEW',
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
        status: 'PENDING_REVIEW',
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
