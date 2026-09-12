import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { ProspectusOcrService } from './prospectus-ocr.service.js';
import { SelectSchoolDto } from './dto/select-school.dto.js';
import { BatchUpdateSubjectsDto } from './dto/batch-update-subjects.dto.js';
import { FreezeBaselineDto } from './dto/freeze-baseline.dto.js';

@Injectable()
export class AcademicBaselineService {
  private readonly logger = new Logger(AcademicBaselineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly settingsService: SettingsService,
    private readonly eventsGateway: EventsGateway,
    private readonly prospectusOcrService: ProspectusOcrService,
  ) {}

  // 1. Get complete baseline onboarding state for current scholar
  async getScholarBaselineState(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        school_grading_system: true,
        prospectus: {
          include: {
            subjects: {
              orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
            },
            document: true,
            frozen_by_employee: {
              select: { employee_id: true, first_name: true, last_name: true, title: true },
            },
          },
        },
        documents: {
          where: {
            document_type: { in: ['PROSPECTUS', 'HISTORICAL_CCG', 'TOR', 'GRADE_SLIP'] },
          },
          orderBy: { uploaded_at: 'desc' },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const subjects = scholar.prospectus?.subjects || [];
    let totalUnits = 0;
    let creditedUnits = 0;
    let untakenUnits = 0;
    let creditedCount = 0;
    let untakenCount = 0;

    for (const sub of subjects) {
      const u = Number(sub.units) || 0;
      totalUnits += u;
      if (sub.status === 'CREDITED' || sub.status === 'PASSED') {
        creditedUnits += u;
        creditedCount++;
      } else {
        untakenUnits += u;
        untakenCount++;
      }
    }

    return {
      profile_id: scholar.profile_id,
      student_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
      student_number: scholar.student_number,
      course_of_study: scholar.course_of_study,
      current_year_level: scholar.current_year_level,
      academic_baseline_status: scholar.academic_baseline_status,
      school_grading_system: scholar.school_grading_system,
      prospectus: scholar.prospectus,
      documents: scholar.documents,
      metrics: {
        total_subjects: subjects.length,
        total_units: Number(totalUnits.toFixed(1)),
        credited_subjects: creditedCount,
        credited_units: Number(creditedUnits.toFixed(1)),
        untaken_subjects: untakenCount,
        remaining_units: Number(untakenUnits.toFixed(1)),
        is_baseline_frozen: scholar.prospectus?.is_frozen ?? false,
      },
    };
  }

  // 2. Scholar selects or proposes school grading system
  async selectOrProposeSchool(userId: number, dto: SelectSchoolDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    let targetSchoolId: number;

    if (dto.school_id) {
      const existingSchool = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: dto.school_id },
      });
      if (!existingSchool) {
        throw new NotFoundException(`School grading ID ${dto.school_id} not found.`);
      }
      targetSchoolId = existingSchool.school_id;
    } else if (dto.new_school_name) {
      // Check if school already exists by name
      const existing = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_name: dto.new_school_name.trim() },
      });
      if (existing) {
        targetSchoolId = existing.school_id;
      } else {
        // Create new unverified school grading scale proposed by student
        const newSchool = await this.settingsService.createSchoolGrading(
          userId,
          {
            school_name: dto.new_school_name.trim(),
            grading_scale: dto.grading_scale || 'NUMERIC_4_POINT',
            passing_grade: dto.passing_grade ?? 2.0,
            highest_grade: dto.highest_grade ?? 4.0,
            failing_grade: dto.failing_grade ?? 1.0,
            min_grade: dto.min_grade ?? 1.0,
            max_grade: dto.max_grade ?? 4.0,
            special_codes: dto.special_codes,
            notes: dto.notes,
            is_verified: false,
          },
          'SCHOLAR',
        );
        targetSchoolId = newSchool.school_id;
      }
    } else {
      throw new BadRequestException('Either school_id or new_school_name must be provided.');
    }

    const nextStatus =
      scholar.academic_baseline_status === 'PENDING_SCHOOL_SELECTION'
        ? 'PENDING_PROSPECTUS'
        : scholar.academic_baseline_status;

    const updated = await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        school_id: targetSchoolId,
        academic_baseline_status: nextStatus,
      },
      include: {
        school_grading_system: true,
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SCHOOL_SELECTED',
      `Scholar selected school grading system '${updated.school_grading_system?.school_name}' (ID: ${targetSchoolId}).`,
    );

    this.eventsGateway.emitToUser(userId, 'baseline:school_selected', {
      school_id: targetSchoolId,
      school_name: updated.school_grading_system?.school_name,
      academic_baseline_status: updated.academic_baseline_status,
    });

    return {
      message: 'Institution grading configuration confirmed.',
      scholar_profile: updated,
    };
  }

  // 3. Upload Prospectus Document & Trigger Batch Ingestion OCR
  async uploadProspectus(userId: number, files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one prospectus file is required.');
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

    // Run OCR Prospectus extraction
    const inputFiles = files.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype,
      fileName: f.originalname,
      fileUrl: uploadResult.secure_url,
    }));

    const extracted = await this.prospectusOcrService.processProspectusExtraction(inputFiles);

    // Save or update ScholarProspectus record
    const prospectus = await this.prisma.scholarProspectus.upsert({
      where: { scholar_profile_id: scholar.profile_id },
      create: {
        scholar_profile_id: scholar.profile_id,
        document_id: doc.document_id,
        curriculum_year: extracted.curriculum_year || 'Current Catalog',
        course_code: extracted.course_code || undefined,
        course_name: extracted.course_name || scholar.course_of_study || 'Degree Program',
        total_units: extracted.total_units ? Number(extracted.total_units) : undefined,
        status: 'DRAFT',
      },
      update: {
        document_id: doc.document_id,
        curriculum_year: extracted.curriculum_year || 'Current Catalog',
        course_code: extracted.course_code || undefined,
        course_name: extracted.course_name || scholar.course_of_study || 'Degree Program',
        total_units: extracted.total_units ? Number(extracted.total_units) : undefined,
        status: 'DRAFT',
      },
    });

    // Delete existing uncredited/untaken subjects to replace with fresh extraction
    await this.prisma.prospectusSubject.deleteMany({
      where: {
        prospectus_id: prospectus.prospectus_id,
        status: { in: ['UNTAKEN', 'DRAFT'] },
      },
    });

    // Insert extracted subjects
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
          status: 'UNTAKEN',
        })),
      });
    }

    // Update document with extracted data JSON
    await this.prisma.scholarDocument.update({
      where: { document_id: doc.document_id },
      data: {
        extracted_data: extracted as any,
      },
    });

    const nextStatus =
      scholar.current_year_level && scholar.current_year_level > 1
        ? 'PENDING_HISTORICAL_CCG'
        : 'PENDING_COORDINATOR_REVIEW';

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
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
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
      message: 'Prospectus extracted and curriculum baseline initialized successfully.',
      prospectus: fullProspectus,
      academic_baseline_status: nextStatus,
    };
  }

  // 4. Scholar / Staff updates prospectus subjects before freezing
  async updateProspectusSubjects(
    userId: number,
    dto: BatchUpdateSubjectsDto,
    isStaff = false,
  ) {
    let scholarProfileId: number;

    if (isStaff) {
      // If staff calls this without profile context, we assume caller passes proper prospectus
      throw new BadRequestException('Staff should use coordinatorUpdateSubjects endpoint.');
    } else {
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { user_id: userId },
        include: { prospectus: true },
      });
      if (!scholar) throw new NotFoundException('Scholar profile not found.');
      if (scholar.prospectus?.is_frozen) {
        throw new ForbiddenException('Your academic baseline is frozen and cannot be modified.');
      }
      scholarProfileId = scholar.profile_id;
    }

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
    });

    if (!prospectus) {
      throw new NotFoundException('Scholar prospectus record not found. Please upload a prospectus first.');
    }

    // Update prospectus metadata if supplied
    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectus.prospectus_id },
      data: {
        course_name: dto.course_name || undefined,
        course_code: dto.course_code || undefined,
        curriculum_year: dto.curriculum_year || undefined,
      },
    });

    // Process subjects: update or recreate
    for (const sub of dto.subjects) {
      if (sub.subject_id) {
        await this.prisma.prospectusSubject.update({
          where: { subject_id: sub.subject_id },
          data: {
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || undefined,
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      } else {
        await this.prisma.prospectusSubject.create({
          data: {
            prospectus_id: prospectus.prospectus_id,
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || 'UNTAKEN',
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      }
    }

    const updated = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectus.prospectus_id },
      include: {
        subjects: {
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBJECTS_UPDATED',
      `Updated ${dto.subjects.length} subjects on prospectus ID ${prospectus.prospectus_id}.`,
    );

    return {
      message: 'Prospectus subjects saved successfully.',
      prospectus: updated,
    };
  }

  // 5. Upload Historical CCG / TOR & Auto-Credit Passed Courses
  async uploadHistoricalCcg(userId: number, files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one historical grade transcript file is required.');
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
      throw new BadRequestException('Please upload and establish your prospectus first before historical grades.');
    }

    if (scholar.prospectus.is_frozen) {
      throw new ForbiddenException('Your academic baseline is frozen and cannot be modified.');
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
      await this.prospectusOcrService.processHistoricalCcgExtraction(inputFiles);

    const schoolConfig = scholar.school_grading_system;
    const prospectusSubjects = scholar.prospectus.subjects;

    const matchedCredited: Array<{ subject_code: string; grade: number; title: string }> = [];
    const unmappedItems: Array<{ subject_code: string; grade: number }> = [];

    // Reconcile extracted historical grades with ProspectusSubjects
    for (const hCourse of historicalCourses) {
      const normalizedHistoricalCode = this.prospectusOcrService.normalizeSubjectCode(hCourse.subject_code);

      // Find matching prospectus subject
      const targetSub = prospectusSubjects.find((ps) => {
        const normalizedProspectusCode = this.prospectusOcrService.normalizeSubjectCode(ps.subject_code);
        return normalizedProspectusCode === normalizedHistoricalCode;
      });

      if (targetSub) {
        // Evaluate grade
        let isPassing = true;
        if (schoolConfig) {
          const evalResult = this.settingsService.evaluateStudentGrade(hCourse.grade, schoolConfig);
          isPassing = evalResult.isPassing;
        } else {
          // Standard check (e.g. 75 or higher, or <= 3.0 on 5-point scale)
          isPassing = hCourse.grade >= 75 || (hCourse.grade >= 1.0 && hCourse.grade <= 3.0);
        }

        const newStatus = isPassing ? 'CREDITED' : 'FAILED';

        await this.prisma.prospectusSubject.update({
          where: { subject_id: targetSub.subject_id },
          data: {
            status: newStatus,
            grade: hCourse.grade,
            historical_document_id: doc.document_id,
            credited_term: hCourse.semester || `${targetSub.year_level} Year - ${targetSub.semester}`,
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
      data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
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
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
      },
    });

    return {
      message: `Historical grades processed. Successfully credited ${matchedCredited.length} subjects.`,
      matched_credited: matchedCredited,
      unmapped_items: unmappedItems,
      prospectus: refreshedProspectus,
      academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
    };
  }

  // 6. Scholar submits baseline for coordinator freeze review
  async submitForReview(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { prospectus: { include: { subjects: true } } },
    });

    if (!scholar) throw new NotFoundException('Scholar profile not found.');
    if (!scholar.prospectus) {
      throw new BadRequestException('Please upload your prospectus before submitting for review.');
    }
    if (scholar.prospectus.subjects.length === 0) {
      throw new BadRequestException('No subjects found on prospectus checklist.');
    }

    const updated = await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
    });

    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: scholar.prospectus.prospectus_id },
      data: { status: 'PENDING_REVIEW' },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBMITTED_FOR_REVIEW',
      `Scholar ${scholar.first_name} ${scholar.last_name} submitted academic baseline for coordinator freeze review.`,
    );

    const payload = {
      scholarProfileId: scholar.profile_id,
      studentName: `${scholar.first_name} ${scholar.last_name}`.trim(),
      courseOfStudy: scholar.course_of_study,
      schoolName: scholar.school_name,
      subjectsCount: scholar.prospectus.subjects.length,
      submittedAt: new Date().toISOString(),
    };

    this.eventsGateway.emitToStaff('baseline:submitted_for_review', payload);
    this.eventsGateway.emitToUser(userId, 'baseline:submitted_for_review', payload);

    return {
      message: 'Academic baseline submitted for coordinator review.',
      academic_baseline_status: updated.academic_baseline_status,
    };
  }

  // 7. Coordinator: Get all scholars awaiting baseline review / frozen status
  async getCoordinatorPendingBaselines() {
    return this.prisma.scholarProfile.findMany({
      where: {
        academic_baseline_status: { in: ['PENDING_COORDINATOR_REVIEW', 'PENDING_PROSPECTUS', 'PENDING_HISTORICAL_CCG', 'BASELINE_FROZEN'] },
      },
      include: {
        user: { select: { email: true, role: true } },
        school_grading_system: true,
        prospectus: {
          include: {
            document: true,
            frozen_by_employee: {
              select: { first_name: true, last_name: true },
            },
          },
        },
      },
      orderBy: { profile_id: 'desc' },
    });
  }

  // 8. Coordinator: Get full side-by-side audit bundle for a scholar
  async getCoordinatorBaselineReview(scholarProfileId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: scholarProfileId },
      include: {
        user: { select: { email: true, created_at: true } },
        school_grading_system: true,
        prospectus: {
          include: {
            document: true,
            subjects: {
              orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
            },
            frozen_by_employee: true,
          },
        },
        documents: {
          where: {
            document_type: { in: ['PROSPECTUS', 'HISTORICAL_CCG', 'TOR', 'GRADE_SLIP'] },
          },
          orderBy: { uploaded_at: 'desc' },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException(`Scholar profile ID ${scholarProfileId} not found.`);
    }

    const subjects = scholar.prospectus?.subjects || [];
    let totalUnits = 0;
    let creditedUnits = 0;
    let untakenUnits = 0;

    for (const sub of subjects) {
      const u = Number(sub.units) || 0;
      totalUnits += u;
      if (sub.status === 'CREDITED' || sub.status === 'PASSED') {
        creditedUnits += u;
      } else {
        untakenUnits += u;
      }
    }

    return {
      scholar_profile: {
        profile_id: scholar.profile_id,
        student_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
        student_number: scholar.student_number,
        course_of_study: scholar.course_of_study,
        school_name: scholar.school_name,
        current_year_level: scholar.current_year_level,
        email: scholar.user.email,
        academic_baseline_status: scholar.academic_baseline_status,
      },
      school_grading_system: scholar.school_grading_system,
      prospectus: scholar.prospectus,
      documents: scholar.documents,
      metrics: {
        total_subjects: subjects.length,
        total_units: Number(totalUnits.toFixed(1)),
        credited_units: Number(creditedUnits.toFixed(1)),
        remaining_units: Number(untakenUnits.toFixed(1)),
        is_frozen: scholar.prospectus?.is_frozen ?? false,
      },
    };
  }

  // 9. Coordinator updates / adds / adjusts subjects on a prospectus
  async coordinatorUpdateSubjects(
    employeeUserId: number,
    prospectusId: number,
    dto: BatchUpdateSubjectsDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
    });
    if (!prospectus) throw new NotFoundException(`Prospectus ID ${prospectusId} not found.`);

    // Update metadata if provided
    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectusId },
      data: {
        course_name: dto.course_name || undefined,
        course_code: dto.course_code || undefined,
        curriculum_year: dto.curriculum_year || undefined,
      },
    });

    for (const sub of dto.subjects) {
      if (sub.subject_id) {
        await this.prisma.prospectusSubject.update({
          where: { subject_id: sub.subject_id },
          data: {
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || undefined,
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      } else {
        await this.prisma.prospectusSubject.create({
          data: {
            prospectus_id: prospectusId,
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || 'UNTAKEN',
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      }
    }

    const updated = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
      include: {
        subjects: {
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
      },
    });

    await this.auditService.log(
      employeeUserId,
      'COORDINATOR_UPDATED_BASELINE_SUBJECTS',
      `Coordinator updated ${dto.subjects.length} subjects on prospectus ID ${prospectusId}.`,
    );

    return {
      message: 'Prospectus subjects updated by coordinator.',
      prospectus: updated,
    };
  }

  // 10. Coordinator: Freeze Baseline (Locks curriculum from further changes)
  async freezeBaseline(
    employeeUserId: number,
    prospectusId: number,
    dto: FreezeBaselineDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
      include: {
        scholar_profile: { include: { user: true } },
        subjects: true,
      },
    });

    if (!prospectus) {
      throw new NotFoundException(`Prospectus ID ${prospectusId} not found.`);
    }

    if (prospectus.is_frozen) {
      throw new BadRequestException('This academic baseline is already frozen.');
    }

    const frozenAt = new Date();

    const updatedProspectus = await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectusId },
      data: {
        is_frozen: true,
        frozen_at: frozenAt,
        frozen_by_employee_id: employee.employee_id,
        status: 'FROZEN',
      },
      include: {
        subjects: {
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
        frozen_by_employee: {
          select: { first_name: true, last_name: true, title: true },
        },
      },
    });

    // Update scholar profile status to BASELINE_FROZEN
    await this.prisma.scholarProfile.update({
      where: { profile_id: prospectus.scholar_profile_id },
      data: { academic_baseline_status: 'BASELINE_FROZEN' },
    });

    const studentName =
      `${prospectus.scholar_profile.first_name} ${prospectus.scholar_profile.last_name}`.trim();

    await this.auditService.log(
      employeeUserId,
      'BASELINE_FROZEN',
      `Coordinator ${employee.first_name} ${employee.last_name} froze academic baseline for scholar ${studentName} (Prospectus ID: ${prospectusId}). Remarks: ${dto?.remarks || 'None'}`,
    );

    const payload = {
      prospectusId,
      scholarProfileId: prospectus.scholar_profile_id,
      studentName,
      isFrozen: true,
      frozenAt: frozenAt.toISOString(),
      frozenBy: `${employee.first_name} ${employee.last_name}`.trim(),
      academic_baseline_status: 'BASELINE_FROZEN',
    };

    this.eventsGateway.emitToStaff('baseline:frozen', payload);
    if (prospectus.scholar_profile.user_id) {
      this.eventsGateway.emitToUser(
        prospectus.scholar_profile.user_id,
        'baseline:frozen',
        payload,
      );
    }

    return {
      message: `Academic baseline for ${studentName} has been frozen and locked successfully.`,
      prospectus: updatedProspectus,
      academic_baseline_status: 'BASELINE_FROZEN',
    };
  }

  // 11. Coordinator: Unfreeze Baseline (Unlocks if manual revision needed)
  async unfreezeBaseline(employeeUserId: number, prospectusId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
      include: { scholar_profile: true },
    });

    if (!prospectus) {
      throw new NotFoundException(`Prospectus ID ${prospectusId} not found.`);
    }

    const updated = await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectusId },
      data: {
        is_frozen: false,
        status: 'PENDING_REVIEW',
      },
    });

    await this.prisma.scholarProfile.update({
      where: { profile_id: prospectus.scholar_profile_id },
      data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
    });

    await this.auditService.log(
      employeeUserId,
      'BASELINE_UNFROZEN',
      `Coordinator ${employee.first_name} ${employee.last_name} unlocked academic baseline for prospectus ID ${prospectusId}.`,
    );

    this.eventsGateway.emitToStaff('baseline:unfrozen', {
      prospectusId,
      scholarProfileId: prospectus.scholar_profile_id,
    });

    return {
      message: 'Academic baseline unlocked for edits.',
      prospectus: updated,
      academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
    };
  }
}
