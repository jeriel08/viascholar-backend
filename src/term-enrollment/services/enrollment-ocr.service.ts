import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LlamaExtractService } from '../../documents/extractors/llama-extract.service.js';
import { InputDocumentFile } from '../../documents/extractors/document-extractor.interface.js';

export interface ExtractedCorSubject {
  subject_code: string;
  descriptive_title: string;
  section?: string;
  schedule?: string;
  room?: string;
  units: number;
}

export interface ExtractedCorData {
  student_name?: string;
  student_number?: string;
  school_name?: string;
  course_name?: string;
  academic_year?: string;
  semester?: string;
  year_level?: number;
  total_units: number;
  subjects: ExtractedCorSubject[];
}

export interface ExtractedSoaData {
  student_name?: string;
  student_number?: string;
  school_name?: string;
  academic_year?: string;
  semester?: string;
  assessment_date?: string;
  total_assessment: number;
  tuition_fee?: number;
  lab_fees?: number;
  misc_fees?: number;
  other_fees?: number;
  previous_balance?: number;
  discounts?: number;
  net_balance_due?: number;
}

export interface ExtractedConsolidatedData extends ExtractedCorData {
  assessment_date?: string;
  total_assessment: number;
  tuition_fee?: number;
  lab_fees?: number;
  misc_fees?: number;
  other_fees?: number;
  previous_balance?: number;
  discounts?: number;
  net_balance_due?: number;
}

@Injectable()
export class EnrollmentOcrService {
  private readonly logger = new Logger(EnrollmentOcrService.name);

  constructor(private readonly llamaExtractService: LlamaExtractService) {}

  normalizeSubjectCode(code: string): string {
    if (!code) return '';
    return code
      .trim()
      .toUpperCase()
      .replace(/[\s\-_.\/\\]+/g, '')
      .replace(/(?<=[A-Z])III$/g, '3')
      .replace(/(?<=[A-Z])II$/g, '2')
      .replace(/(?<=[A-Z])I$/g, '1');
  }

  normalizeSemester(sem: string): string {
    if (!sem) return '1st Semester';
    const lower = sem.toLowerCase();
    if (lower.includes('summer') || lower.includes('midyear')) return 'Summer';
    if (lower.includes('2nd') || lower.includes('second'))
      return '2nd Semester';
    if (lower.includes('3rd') || lower.includes('third'))
      return '3rd Trimester';
    return '1st Semester';
  }

  normalizeYearLevel(year: any): number {
    if (typeof year === 'number' && year >= 1 && year <= 6)
      return Math.floor(year);
    if (typeof year === 'string') {
      const match = year.match(/\d/);
      if (match) {
        const parsed = parseInt(match[0], 10);
        if (parsed >= 1 && parsed <= 6) return parsed;
      }
      if (/first|1st/i.test(year)) return 1;
      if (/second|2nd/i.test(year)) return 2;
      if (/third|3rd/i.test(year)) return 3;
      if (/fourth|4th/i.test(year)) return 4;
      if (/fifth|5th/i.test(year)) return 5;
    }
    return 1;
  }

  async parseCor(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedCorData> {
    this.logger.log('Dispatching COR document to LlamaExtract...');
    const raw = await this.llamaExtractService.extractEnrollmentCorData(input);

    // 1. Strict Document Type Checking
    if (
      raw.detected_document_type === 'STATEMENT_OF_ACCOUNT' ||
      (raw.is_assessment_form && !raw.is_class_schedule)
    ) {
      throw new BadRequestException(
        'The uploaded document is a Statement of Account or Tuition Fee Assessment. Please upload your Proof of Enrolled Subjects (Certificate of Registration / Class Schedule) in this input, or switch to Consolidated mode if your form contains both.',
      );
    }
    if (
      raw.detected_document_type === 'OTHER' ||
      !raw.subjects ||
      raw.subjects.length === 0
    ) {
      throw new BadRequestException(
        'The uploaded document does not appear to be an official Certificate of Registration or Class Schedule. Please upload a valid enrollment document.',
      );
    }

    const subjects: ExtractedCorSubject[] = (raw.subjects || [])
      .map((s: any) => ({
        subject_code: (s.subject_code || '').trim().toUpperCase(),
        descriptive_title: (s.descriptive_title || s.subject_code || '').trim(),
        section: s.section ? String(s.section).trim() : undefined,
        schedule: s.schedule ? String(s.schedule).trim() : undefined,
        room: s.room ? String(s.room).trim() : undefined,
        units: Number(s.units) > 0 ? Number(s.units) : 3.0,
      }))
      .filter((s: ExtractedCorSubject) => Boolean(s.subject_code));

    if (subjects.length === 0) {
      throw new BadRequestException(
        'No registered courses or class schedule were detected in the uploaded file. Please make sure to upload an official Certificate of Registration (COR) or Class Schedule showing your enrolled subjects.',
      );
    }

    // Filter out fee items accidentally parsed as subjects
    const feeKeywords =
      /tuition|matriculation|miscellaneous|athletic|library|medical|dental|registration\s+fee|guidance|id\s+fee|energy\s+fee|assessment|laboratory\s+fee|discount|downpayment/i;
    const academicSubjects = subjects.filter(
      (s) =>
        !feeKeywords.test(s.subject_code) &&
        !feeKeywords.test(s.descriptive_title),
    );
    if (academicSubjects.length === 0) {
      throw new BadRequestException(
        'The uploaded document appears to be a tuition billing ledger rather than an enrolled class schedule. Please upload your Certificate of Registration or Class Schedule.',
      );
    }

    const totalUnits =
      Number(raw.total_units) > 0
        ? Number(raw.total_units)
        : academicSubjects.reduce((sum, s) => sum + s.units, 0);

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      course_name: raw.course_name,
      academic_year: raw.academic_year,
      semester: this.normalizeSemester(raw.semester),
      year_level: this.normalizeYearLevel(raw.year_level),
      total_units: totalUnits,
      subjects: academicSubjects,
    };
  }

  async parseSoa(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedSoaData> {
    this.logger.log('Dispatching SOA document to LlamaExtract...');
    const raw = await this.llamaExtractService.extractEnrollmentSoaData(input);

    // 1. Strict Document Type Checking
    if (
      raw.detected_document_type === 'CERTIFICATE_OF_REGISTRATION' ||
      (raw.is_class_schedule && !raw.is_assessment_form)
    ) {
      throw new BadRequestException(
        'The uploaded document is a Certificate of Registration or Class Schedule, not a Statement of Account. Please upload your Tuition Fee Assessment, Statement of Account (SOA), or Student Ledger in this input.',
      );
    }
    if (raw.detected_document_type === 'OTHER') {
      throw new BadRequestException(
        'The uploaded document does not appear to be an official Statement of Account or Tuition Assessment. Please upload a valid billing or ledger document.',
      );
    }

    const totalAssessment = Number(raw.total_assessment) || 0;
    const hasFeeBreakdown = Boolean(
      raw.tuition_fee ||
        raw.lab_fees ||
        raw.misc_fees ||
        raw.other_fees ||
        raw.net_balance_due,
    );

    if (totalAssessment <= 0 && !hasFeeBreakdown) {
      throw new BadRequestException(
        'No tuition assessment balance or fee charges were detected in the uploaded file. Please upload an official Statement of Account (SOA), Tuition Fee Assessment, or Student Ledger.',
      );
    }

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      academic_year: raw.academic_year,
      semester: this.normalizeSemester(raw.semester),
      assessment_date: raw.assessment_date,
      total_assessment: totalAssessment,
      tuition_fee:
        raw.tuition_fee != null ? Number(raw.tuition_fee) : undefined,
      lab_fees: raw.lab_fees != null ? Number(raw.lab_fees) : undefined,
      misc_fees: raw.misc_fees != null ? Number(raw.misc_fees) : undefined,
      other_fees: raw.other_fees != null ? Number(raw.other_fees) : undefined,
      previous_balance:
        raw.previous_balance != null ? Number(raw.previous_balance) : undefined,
      discounts: raw.discounts != null ? Number(raw.discounts) : undefined,
      net_balance_due:
        raw.net_balance_due != null
          ? Number(raw.net_balance_due)
          : totalAssessment,
    };
  }

  async parseConsolidated(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedConsolidatedData> {
    this.logger.log(
      'Dispatching Consolidated COR+SOA document to LlamaExtract...',
    );
    const raw =
      await this.llamaExtractService.extractConsolidatedEnrollmentData(input);

    const subjects: ExtractedCorSubject[] = (raw.subjects || [])
      .map((s: any) => ({
        subject_code: (s.subject_code || '').trim().toUpperCase(),
        descriptive_title: (s.descriptive_title || s.subject_code || '').trim(),
        section: s.section ? String(s.section).trim() : undefined,
        schedule: s.schedule ? String(s.schedule).trim() : undefined,
        room: s.room ? String(s.room).trim() : undefined,
        units: Number(s.units) > 0 ? Number(s.units) : 3.0,
      }))
      .filter((s: ExtractedCorSubject) => Boolean(s.subject_code));

    if (subjects.length === 0) {
      throw new BadRequestException(
        'No enrolled subjects found in the consolidated document. Please ensure your form contains both your registered courses and tuition assessment.',
      );
    }

    const totalAssessment = Number(raw.total_assessment) || 0;
    const hasFeeBreakdown = Boolean(
      raw.tuition_fee ||
        raw.lab_fees ||
        raw.misc_fees ||
        raw.other_fees ||
        raw.net_balance_due,
    );
    if (totalAssessment <= 0 && !hasFeeBreakdown) {
      throw new BadRequestException(
        'No tuition assessment balance found in the consolidated document. If your school issues separate documents for class schedule and tuition billing, please turn off Consolidated mode.',
      );
    }

    const totalUnits =
      Number(raw.total_units) > 0
        ? Number(raw.total_units)
        : subjects.reduce((sum, s) => sum + s.units, 0);

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      course_name: raw.course_name,
      academic_year: raw.academic_year,
      semester: this.normalizeSemester(raw.semester),
      year_level: this.normalizeYearLevel(raw.year_level),
      total_units: totalUnits,
      assessment_date: raw.assessment_date,
      total_assessment: totalAssessment,
      tuition_fee:
        raw.tuition_fee != null ? Number(raw.tuition_fee) : undefined,
      lab_fees: raw.lab_fees != null ? Number(raw.lab_fees) : undefined,
      misc_fees: raw.misc_fees != null ? Number(raw.misc_fees) : undefined,
      other_fees: raw.other_fees != null ? Number(raw.other_fees) : undefined,
      previous_balance:
        raw.previous_balance != null ? Number(raw.previous_balance) : undefined,
      discounts: raw.discounts != null ? Number(raw.discounts) : undefined,
      net_balance_due:
        raw.net_balance_due != null
          ? Number(raw.net_balance_due)
          : totalAssessment,
      subjects,
    };
  }
}
