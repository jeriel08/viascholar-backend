import { createHash } from 'node:crypto';
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
import { EventsGateway } from '../../events/events.gateway.js';
import {
  type NormalizedProspectusData,
  ProspectusOcrService,
} from '../prospectus-ocr.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

const STOP_WORDS = new Set([
  'in',
  'of',
  'the',
  'and',
  'major',
  'with',
  'specialization',
  'track',
  'program',
  'degree',
]);

function normalizeProgramLabel(value?: string | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/\bbachelor\s+of\s+science\s+in\b/g, 'bs ')
    .replace(/\bbachelor\s+of\s+arts\s+in\b/g, 'ba ')
    .replace(/\bbachelor\s+of\b/g, 'b ')
    .replace(/\bb\.?\s*s\.?\b/g, 'bs')
    .replace(/\bb\.?\s*a\.?\b/g, 'ba')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getProgramTokens(value?: string | null): string[] {
  const norm = normalizeProgramLabel(value);
  if (!norm) return [];
  return norm.split(' ').filter((w) => w && !STOP_WORDS.has(w));
}

function getProgramAcronym(value?: string | null): string {
  const tokens = getProgramTokens(value);
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0];
  if (tokens[0] === 'bs' || tokens[0] === 'ba') {
    return (
      tokens[0] +
      tokens
        .slice(1)
        .map((t) => t[0])
        .join('')
    );
  }
  return tokens.map((t) => t[0]).join('');
}

function programsMatch(
  aName?: string | null,
  aCode?: string | null,
  bName?: string | null,
  bCode?: string | null,
): boolean {
  const normAName = normalizeProgramLabel(aName).replace(/\s+/g, '');
  const normBName = normalizeProgramLabel(bName).replace(/\s+/g, '');
  const normACode = (aCode || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normBCode = (bCode || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  if (normACode && normBCode && normACode === normBCode) return true;
  if (normAName && normBName && normAName === normBName) return true;

  const acroA = getProgramAcronym(aName);
  const acroB = getProgramAcronym(bName);
  if (normACode && acroB && normACode === acroB) return true;
  if (normBCode && acroA && normBCode === acroA) return true;
  if (acroA && acroB && acroA.length >= 3 && acroA === acroB) return true;

  const tokensA = getProgramTokens(aName).filter(
    (t) => t !== 'bs' && t !== 'ba',
  );
  const tokensB = getProgramTokens(bName).filter(
    (t) => t !== 'bs' && t !== 'ba',
  );
  if (tokensA.length > 0 && tokensB.length > 0) {
    const setB = new Set(tokensB);
    const shared = tokensA.filter((t) => setB.has(t)).length;
    const minLen = Math.min(tokensA.length, tokensB.length);
    if (shared === minLen && shared >= 1) return true;
  }

  return false;
}

@Injectable()
export class BaselineDocumentIngestionService {
  private readonly logger = new Logger(BaselineDocumentIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly eventsGateway: EventsGateway,
    private readonly prospectusOcrService: ProspectusOcrService,
    private readonly cacheService: AppCacheService,
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

    const isShiftUpload =
      scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS';

    if (scholar.prospectus?.is_frozen && !isShiftUpload) {
      throw new ForbiddenException(
        'Your academic baseline curriculum is already frozen and cannot be modified.',
      );
    }

    const firstFile = files[0];
    const fileHash = createHash('sha256')
      .update(firstFile.buffer)
      .digest('hex');

    if (
      scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS' &&
      typeof (this.prisma as any).scholarDocument?.findMany === 'function'
    ) {
      const latestShiftForHash =
        typeof (this.prisma as any).academicChangeRequest?.findFirst ===
        'function'
          ? await (this.prisma as any).academicChangeRequest.findFirst({
              where: { scholar_profile_id: scholar.profile_id, status: 'APPROVED' },
              select: { reviewed_at: true },
              orderBy: { reviewed_at: 'desc' },
            })
          : null;
      const shiftReviewedMs = latestShiftForHash?.reviewed_at
        ? new Date(latestShiftForHash.reviewed_at).getTime()
        : 0;
      const priorDocs = await this.prisma.scholarDocument.findMany({
        where: {
          scholar_profile_id: scholar.profile_id,
          document_type: 'PROSPECTUS',
        },
        orderBy: { uploaded_at: 'desc' },
        take: 10,
      });
      const preShiftDocs =
        shiftReviewedMs > 0
          ? priorDocs.filter(
              (d) =>
                !d.uploaded_at ||
                new Date(d.uploaded_at).getTime() <= shiftReviewedMs,
            )
          : priorDocs;
      const isExactDuplicateFile = preShiftDocs.some((d) => {
        const ext = d.extracted_data as Record<string, unknown> | null;
        return typeof ext?.file_hash === 'string' && ext.file_hash === fileHash;
      });
      if (isExactDuplicateFile) {
        throw new BadRequestException(
          'You uploaded the exact same prospectus file from your previous program. Please upload the updated prospectus for your new program.',
        );
      }
    }

    const inputFiles = files.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype,
      fileName: f.originalname,
      fileUrl: '',
    }));

    // Execute Cloudinary upload and OCR extraction concurrently
    const [uploadResult, extracted] = await Promise.all([
      this.cloudinaryService.uploadBuffer(
        firstFile.buffer,
        'viascholar/prospectus',
        `prospectus_${scholar.profile_id}_${Date.now()}`,
        'auto',
      ),
      this.prospectusOcrService.processProspectusExtraction(inputFiles),
    ]);

    if (scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS') {
      await this.validateShiftedProspectusUpload(scholar, extracted, fileHash);
    }

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
        ...(isShiftUpload
          ? {
              is_frozen: false,
              frozen_at: null,
              frozen_by_employee_id: null,
            }
          : {}),
      },
    });

    await this.prisma.prospectusSubject.deleteMany({
      where: isShiftUpload
        ? { prospectus_id: prospectus.prospectus_id }
        : {
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
        extracted_data: { ...extracted, file_hash: fileHash } as any,
      },
    });

    const nextStatus =
      scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS'
        ? 'PENDING_SHIFT_PROSPECTUS'
        : 'PENDING_HISTORICAL_CCG';

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

    await this.cacheService.del(`baseline:scholar:${userId}`);
    await this.cacheService.del(`baseline:review:${scholar.profile_id}`);
    await this.cacheService.del(`dashboard:scholar:${userId}`);

    return {
      message:
        'Prospectus extracted and curriculum baseline initialized successfully.',
      prospectus: fullProspectus,
      academic_baseline_status: nextStatus,
    };
  }

  private async validateShiftedProspectusUpload(
    scholar: {
      profile_id: number;
      course_of_study: string | null;
      school_name?: string | null;
      prospectus?: {
        prospectus_id: number;
        subjects?: Array<{ subject_code: string }>;
      } | null;
    },
    extracted: NormalizedProspectusData,
    fileHash: string,
  ): Promise<void> {
    if (!extracted.subjects || extracted.subjects.length === 0) {
      throw new BadRequestException(
        'No curriculum subjects were detected in the uploaded file. Please upload a clear prospectus for your new program with credited grades included.',
      );
    }

    const latestApprovedChange =
      typeof (this.prisma as any).academicChangeRequest?.findFirst ===
      'function'
        ? await (this.prisma as any).academicChangeRequest.findFirst({
            where: {
              scholar_profile_id: scholar.profile_id,
              status: 'APPROVED',
            },
            include: {
              requested_program: {
                select: { program_code: true, program_name: true },
              },
            },
            orderBy: { reviewed_at: 'desc' },
          })
        : null;

    const priorDocs =
      typeof (this.prisma as any).scholarDocument?.findMany === 'function'
        ? await this.prisma.scholarDocument.findMany({
            where: {
              scholar_profile_id: scholar.profile_id,
              document_type: 'PROSPECTUS',
            },
            orderBy: { uploaded_at: 'desc' },
            take: 10,
          })
        : [];

    const shiftReviewedMs = latestApprovedChange?.reviewed_at
      ? new Date(latestApprovedChange.reviewed_at).getTime()
      : 0;
    const preShiftDocs =
      shiftReviewedMs > 0
        ? priorDocs.filter(
            (d) =>
              !d.uploaded_at ||
              new Date(d.uploaded_at).getTime() <= shiftReviewedMs,
          )
        : priorDocs;

    const previousDocWithData = preShiftDocs.find((d) => {
      const ext = d.extracted_data as Record<string, unknown> | null;
      return ext && Array.isArray(ext.subjects) && ext.subjects.length > 0;
    });
    const prevExtracted =
      (previousDocWithData?.extracted_data as
        (NormalizedProspectusData & { file_hash?: string }) | null) ?? null;

    if (prevExtracted?.file_hash && prevExtracted.file_hash === fileHash) {
      throw new BadRequestException(
        'You uploaded the exact same prospectus file from your previous program. Please upload the updated prospectus for your new program.',
      );
    }

    const changeType = latestApprovedChange?.change_type || 'PROGRAM_SHIFT';
    const includesProgramShift =
      changeType === 'PROGRAM_SHIFT' || changeType === 'BOTH';

    const oldCourseName =
      latestApprovedChange?.current_course_of_study ||
      prevExtracted?.course_name ||
      null;
    const oldCourseCode = prevExtracted?.course_code || null;

    const approvedCourseName =
      latestApprovedChange?.requested_course_of_study ||
      scholar.course_of_study ||
      null;
    const approvedCourseCode =
      latestApprovedChange?.requested_program?.program_code || null;

    const hasDetectedCourse = Boolean(
      extracted.course_name?.trim() || extracted.course_code?.trim(),
    );
    const matchesApprovedProgram =
      hasDetectedCourse &&
      approvedCourseName &&
      programsMatch(
        extracted.course_name,
        extracted.course_code,
        approvedCourseName,
        approvedCourseCode,
      );
    const matchesOldProgram =
      hasDetectedCourse &&
      (oldCourseName || oldCourseCode) &&
      programsMatch(
        extracted.course_name,
        extracted.course_code,
        oldCourseName,
        oldCourseCode,
      );

    if (includesProgramShift) {
      if (matchesOldProgram && !matchesApprovedProgram) {
        throw new BadRequestException(
          `The uploaded prospectus (${extracted.course_name || extracted.course_code}) matches your previous program. Please upload the prospectus for your approved new program (${approvedCourseName || 'new program'}).`,
        );
      }

      if (hasDetectedCourse && approvedCourseName && !matchesApprovedProgram) {
        throw new BadRequestException(
          `The uploaded prospectus (${extracted.course_name || extracted.course_code}) does not match your Grantor-approved program (${approvedCourseName}).`,
        );
      }
    }

    let prevSubjects: Array<{ subject_code: string }> =
      prevExtracted?.subjects && prevExtracted.subjects.length > 0
        ? prevExtracted.subjects
        : scholar.prospectus?.subjects || [];

    if (
      prevSubjects.length === 0 &&
      scholar.prospectus?.prospectus_id &&
      typeof (this.prisma as any).prospectusSubject?.findMany === 'function'
    ) {
      prevSubjects = await this.prisma.prospectusSubject.findMany({
        where: { prospectus_id: scholar.prospectus.prospectus_id },
        select: { subject_code: true },
      });
    }

    if (prevSubjects.length >= 5) {
      const newCodes = new Set(
        extracted.subjects
          .map((s) =>
            this.prospectusOcrService.normalizeSubjectCode(s.subject_code),
          )
          .filter(Boolean),
      );
      const oldCodes = new Set(
        prevSubjects
          .map((s) =>
            this.prospectusOcrService.normalizeSubjectCode(s.subject_code),
          )
          .filter(Boolean),
      );

      if (newCodes.size > 0 && oldCodes.size > 0) {
        let shared = 0;
        for (const code of newCodes) {
          if (oldCodes.has(code)) shared++;
        }
        const unionSize = new Set([...newCodes, ...oldCodes]).size;
        const jaccardSimilarity = unionSize > 0 ? shared / unionSize : 0;

        if (includesProgramShift && jaccardSimilarity >= 0.85) {
          throw new BadRequestException(
            'The uploaded prospectus contains the same curriculum subjects as your previous program prospectus. Uploading the old prospectus is blocked to prevent resetting your progress.',
          );
        }

        if (
          !includesProgramShift &&
          jaccardSimilarity >= 0.95 &&
          extracted.curriculum_year &&
          prevExtracted?.curriculum_year &&
          extracted.curriculum_year.trim().toLowerCase() ===
            prevExtracted.curriculum_year.trim().toLowerCase() &&
          Number(extracted.total_units || 0) ===
            Number(prevExtracted.total_units || 0)
        ) {
          throw new BadRequestException(
            'The uploaded prospectus appears identical to your previous school prospectus. Please upload the official prospectus from your new school.',
          );
        }
      }
    }
  }
}
