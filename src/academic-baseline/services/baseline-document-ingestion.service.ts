import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { ProspectusOcrService } from '../prospectus-ocr.service.js';

@Injectable()
export class BaselineDocumentIngestionService {
  private readonly logger = new Logger(BaselineDocumentIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly settingsService: SettingsService,
    private readonly eventsGateway: EventsGateway,
    private readonly prospectusOcrService: ProspectusOcrService,
  ) {}

  // 1. Upload Prospectus Document & Trigger Batch Ingestion OCR
  async uploadProspectus(userId: number, files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException(
        'At least one prospectus file is required.',
      );
    }

    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { prospectus: true },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    if (scholar.prospectus?.is_frozen) {
      throw new ForbiddenException(
        'Your academic baseline curriculum is already frozen and cannot be modified.',
      );
    }

    const firstFile = files[0];
    const uploadResult = await this.cloudinaryService.uploadBuffer(
      firstFile.buffer,
      'viascholar/prospectus',
      `prospectus_${scholar.profile_id}_${Date.now()}`,
      'auto',
    );

    const doc = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: 'PROSPECTUS',
        label: 'Curriculum Evaluation / Prospectus Sheet',
        file_name: firstFile.originalname,
        file_url: uploadResult.secure_url,
        file_size: `${(firstFile.size / 1024).toFixed(1)} KB`,
        file_type: firstFile.mimetype.split('/')[1] || 'pdf',
        status: 'PASSED_PRECHECK',
      },
    });

    const inputFiles = files.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype,
      fileName: f.originalname,
      fileUrl: uploadResult.secure_url,
    }));

    const extracted =
      await this.prospectusOcrService.processProspectusExtraction(inputFiles);

    const prospectus = await this.prisma.scholarProspectus.upsert({
      where: { scholar_profile_id: scholar.profile_id },
      create: {
        scholar_profile_id: scholar.profile_id,
        document_id: doc.document_id,
        curriculum_year: extracted.curriculum_year || 'Current Catalog',
        course_code: extracted.course_code || undefined,
        course_name:
          extracted.course_name || scholar.course_of_study || 'Degree Program',
        total_units: extracted.total_units
          ? Number(extracted.total_units)
          : undefined,
        status: 'DRAFT',
      },
      update: {
        document_id: doc.document_id,
        curriculum_year: extracted.curriculum_year || 'Current Catalog',
        course_code: extracted.course_code || undefined,
        course_name:
          extracted.course_name || scholar.course_of_study || 'Degree Program',
        total_units: extracted.total_units
          ? Number(extracted.total_units)
          : undefined,
        status: 'DRAFT',
      },
    });

    await this.prisma.prospectusSubject.deleteMany({
      where: {
        prospectus_id: prospectus.prospectus_id,
        status: { in: ['UNTAKEN', 'DRAFT'] },
      },
    });

    if (extracted.subjects.length > 0) {
      await this.prisma.prospectusSubject.createMany({
        data: extracted.subjects.map((sub) => ({
          prospectus_id: prospectus.prospectus_id,
          subject_code: sub.subject_code,
          descriptive_title: sub.descriptive_title,
          units: sub.units,
          year_level: sub.year_level,
          semester: sub.semester,
          prerequisites: sub.prerequisites,
          status: sub.status || 'UNTAKEN',
          grade:
            sub.grade !== undefined && sub.grade !== null
              ? sub.grade
              : undefined,
          credited_term: sub.credited_term || undefined,
          remarks: sub.raw_grade_str
            ? `Extracted mark: ${sub.raw_grade_str}`
            : undefined,
        })),
      });
    }

    await this.prisma.scholarDocument.update({
      where: { document_id: doc.document_id },
      data: {
        extracted_data: extracted as any,
      },
    });

    const nextStatus = 'PENDING_HISTORICAL_CCG';

    await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: { academic_baseline_status: nextStatus },
    });

    await this.auditService.log(
      userId,
      'PROSPECTUS_UPLOADED',
      `Scholar uploaded prospectus. Extracted ${extracted.subjects.length} subjects (Total units: ${extracted.total_units}).`,
    );

    const fullProspectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectus.prospectus_id },
      include: {
        subjects: {
          orderBy: [
            { year_level: 'asc' },
            { semester: 'asc' },
            { subject_code: 'asc' },
          ],
        },
        document: true,
      },
    });

    this.eventsGateway.emitToUser(userId, 'baseline:prospectus_processed', {
      prospectusId: prospectus.prospectus_id,
      subjectsCount: extracted.subjects.length,
      status: nextStatus,
    });
    this.eventsGateway.emitToStaff('baseline:prospectus_processed', {
      scholarProfileId: scholar.profile_id,
      studentName: `${scholar.first_name} ${scholar.last_name}`.trim(),
      subjectsCount: extracted.subjects.length,
    });

    return {
      message:
        'Prospectus extracted and curriculum baseline initialized successfully.',
      prospectus: fullProspectus,
      academic_baseline_status: nextStatus,
    };
  }

  // 2. Upload Historical CCG / TOR & Auto-Credit Passed Courses
  async uploadHistoricalCcg(userId: number, files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException(
        'At least one historical grade transcript file is required.',
      );
    }

    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        prospectus: {
          include: { subjects: true },
        },
        school_grading_system: true,
      },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    if (!scholar.prospectus) {
      throw new BadRequestException(
        'Please upload and establish your prospectus first before historical grades.',
      );
    }

    if (scholar.prospectus.is_frozen) {
      throw new ForbiddenException(
        'Your academic baseline is frozen and cannot be modified.',
      );
    }

    const firstFile = files[0];
    const uploadResult = await this.cloudinaryService.uploadBuffer(
      firstFile.buffer,
      'viascholar/historical-ccg',
      `historical_ccg_${scholar.profile_id}_${Date.now()}`,
      'auto',
    );

    const doc = await this.prisma.scholarDocument.create({
      data: {
        scholar_profile_id: scholar.profile_id,
        document_type: 'HISTORICAL_CCG',
        label: 'Historical Certified Copy of Grades / Transcript',
        file_name: firstFile.originalname,
        file_url: uploadResult.secure_url,
        file_size: `${(firstFile.size / 1024).toFixed(1)} KB`,
        file_type: firstFile.mimetype.split('/')[1] || 'pdf',
        status: 'PASSED_PRECHECK',
      },
    });

    const inputFiles = files.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype,
      fileName: f.originalname,
      fileUrl: uploadResult.secure_url,
    }));

    const historicalCourses =
      await this.prospectusOcrService.processHistoricalCcgExtraction(
        inputFiles,
      );

    const schoolConfig = scholar.school_grading_system;
    const prospectusSubjects = scholar.prospectus.subjects;

    const matchedCredited: Array<{
      subject_code: string;
      grade: number;
      title: string;
    }> = [];
    const unmappedItems: Array<{ subject_code: string; grade: number }> = [];

    for (const hCourse of historicalCourses) {
      const normalizedHistoricalCode =
        this.prospectusOcrService.normalizeSubjectCode(hCourse.subject_code);

      const targetSub = prospectusSubjects.find((ps) => {
        const normalizedProspectusCode =
          this.prospectusOcrService.normalizeSubjectCode(ps.subject_code);
        return normalizedProspectusCode === normalizedHistoricalCode;
      });

      if (targetSub) {
        let isPassing = true;
        if (schoolConfig) {
          const evalResult = this.settingsService.evaluateStudentGrade(
            hCourse.grade,
            schoolConfig,
          );
          isPassing = evalResult.isPassing;
        } else {
          isPassing =
            hCourse.grade >= 75 ||
            (hCourse.grade >= 1.0 && hCourse.grade <= 3.0);
        }

        const newStatus = isPassing ? 'CREDITED' : 'FAILED';

        await this.prisma.prospectusSubject.update({
          where: { subject_id: targetSub.subject_id },
          data: {
            status: newStatus,
            grade: hCourse.grade,
            historical_document_id: doc.document_id,
            credited_term:
              hCourse.semester ||
              `${targetSub.year_level} Year - ${targetSub.semester}`,
          },
        });

        matchedCredited.push({
          subject_code: targetSub.subject_code,
          grade: hCourse.grade,
          title: targetSub.descriptive_title,
        });
      } else {
        unmappedItems.push({
          subject_code: hCourse.subject_code,
          grade: hCourse.grade,
        });
      }
    }

    await this.prisma.scholarDocument.update({
      where: { document_id: doc.document_id },
      data: {
        extracted_data: {
          historical_courses: historicalCourses,
          matched_credited: matchedCredited,
          unmapped_items: unmappedItems,
        } as any,
      },
    });

    await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: { academic_baseline_status: 'PENDING_HISTORICAL_CCG' },
    });

    await this.auditService.log(
      userId,
      'HISTORICAL_CCG_PROCESSED',
      `Processed historical CCG for scholar profile ${scholar.profile_id}. Credited ${matchedCredited.length} subjects, ${unmappedItems.length} unmapped items.`,
    );

    const refreshedProspectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: scholar.prospectus.prospectus_id },
      include: {
        subjects: {
          orderBy: [
            { year_level: 'asc' },
            { semester: 'asc' },
            { subject_code: 'asc' },
          ],
        },
      },
    });

    return {
      message: `Historical grades processed. Successfully credited ${matchedCredited.length} subjects.`,
      matched_credited: matchedCredited,
      unmapped_items: unmappedItems,
      prospectus: refreshedProspectus,
      academic_baseline_status: 'PENDING_HISTORICAL_CCG',
    };
  }
}
