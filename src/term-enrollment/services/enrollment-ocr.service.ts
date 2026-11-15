import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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

  normalizeAcademicYear(
    rawAy?: string,
    rawSemester?: string,
  ): string | undefined {
    const extractFromText = (text?: string): string | undefined => {
      if (!text || typeof text !== 'string') return undefined;
      const trimmed = text.trim();
      if (!trimmed) return undefined;

      const rangeMatch = trimmed.match(/\b(20\d{2})\s*[-/]\s*(\d{2,4})\b/);
      if (rangeMatch) {
        const y1 = rangeMatch[1];
        const y2 =
          rangeMatch[2].length === 2 ? `20${rangeMatch[2]}` : rangeMatch[2];
        return `${y1}-${y2}`;
      }

      const singleYearMatch = trimmed.match(/\b(20\d{2})\b/);
      if (singleYearMatch) {
        return singleYearMatch[1];
      }

      return undefined;
    };

    const fromAy = extractFromText(rawAy);
    if (fromAy) return fromAy;

    const fromSem = extractFromText(rawSemester);
    if (fromSem) return fromSem;

    return typeof rawAy === 'string' && rawAy.trim() ? rawAy.trim() : rawAy;
  }

  sanitizeSubject(s: any): ExtractedCorSubject {
    let rawCode = String(s.subject_code || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
    let rawTitle = String(s.descriptive_title || '')
      .replace(/\s+/g, ' ')
      .trim();
    let rawSection = s.section ? String(s.section).trim() : undefined;

    // Handle UM / portal tables where [Code | Title | Description] puts the 4-5 digit numeric class code
    // in subject_code (e.g. "11040") and merges Title + Description into descriptive_title (e.g. "GE 5 SCIENCE, TECHNOLOGY AND SOCIETY")
    if (/^\d{3,7}$/.test(rawCode) && rawTitle) {
      const codePrefixMatch = rawTitle.match(
        /^([A-Z]{2,6}\s*[-_]?\s*\d{1,4}[A-Z]{0,3}(?:\s*\/?\s*L(?:AB|EC)?)?)\s+(.+)$/i,
      );
      if (codePrefixMatch) {
        if (!rawSection) {
          rawSection = rawCode;
        }
        rawCode = codePrefixMatch[1].replace(/\s+/g, ' ').trim().toUpperCase();
        rawTitle = codePrefixMatch[2].trim();
      }
    } else if (
      rawCode &&
      rawTitle &&
      rawTitle.toUpperCase().startsWith(`${rawCode} `) &&
      rawTitle.length > rawCode.length + 1
    ) {
      rawTitle = rawTitle.slice(rawCode.length).trim();
    }

    if (!rawTitle) {
      rawTitle = rawCode;
    }

    return {
      subject_code: rawCode,
      descriptive_title: rawTitle,
      section: rawSection,
      schedule: s.schedule ? String(s.schedule).trim() : undefined,
      room: s.room ? String(s.room).trim() : undefined,
      units: Number(s.units) > 0 ? Number(s.units) : 3.0,
    };
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

  private sanitizeAmount(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
      const cleaned = value.replace(/php|₱|,/gi, '').trim();
      if (!cleaned) return undefined;
      const parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private extractBillingFields(raw: any) {
    const totalAssessment = this.sanitizeAmount(raw.total_assessment) ?? 0;
    const tuition_fee = this.sanitizeAmount(raw.tuition_fee);
    const lab_fees = this.sanitizeAmount(raw.lab_fees);
    const misc_fees = this.sanitizeAmount(raw.misc_fees);
    const other_fees = this.sanitizeAmount(raw.other_fees);
    const previous_balance = this.sanitizeAmount(raw.previous_balance);
    const discounts = this.sanitizeAmount(raw.discounts);
    const net_balance_due =
      this.sanitizeAmount(raw.net_balance_due) ?? totalAssessment;

    const hasFeeBreakdown = [
      tuition_fee,
      lab_fees,
      misc_fees,
      other_fees,
      net_balance_due,
    ].some((amt) => amt != null && amt > 0);

    return {
      totalAssessment,
      hasFeeBreakdown,
      tuition_fee,
      lab_fees,
      misc_fees,
      other_fees,
      previous_balance,
      discounts,
      net_balance_due,
    };
  }

  private async extractRawSafely(
    docLabel: string,
    guidanceMessage: string,
    extractor: () => Promise<any>,
  ): Promise<any> {
    let raw: any;
    try {
      raw = await extractor();
    } catch (err: any) {
      if (err instanceof HttpException) {
        throw err;
      }
      const message = String(err?.message || err || '');
      if (message.includes('LLAMA_CLOUD_API_KEY')) {
        throw new ServiceUnavailableException(
          'Document OCR service is temporarily unavailable because credentials are not configured.',
        );
      }
      this.logger.warn(
        `Failed to parse uploaded file as ${docLabel}: ${message}`,
      );
      throw new BadRequestException(guidanceMessage);
    }

    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(guidanceMessage);
    }
    return raw;
  }

  async parseCor(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedCorData> {
    this.logger.log('Dispatching COR document to LlamaExtract...');
    const raw = await this.extractRawSafely(
      'Certificate of Registration (COR)',
      'We could not read a valid Certificate of Registration or Class Schedule from this file. Please upload a clear PDF or image of your official COR / Study Load.',
      () => this.llamaExtractService.extractEnrollmentCorData(input),
    );

    // 1. Strict Document Type Checking
    if (
      raw.detected_document_type === 'STATEMENT_OF_ACCOUNT' ||
      (raw.is_assessment_form && !raw.is_class_schedule)
    ) {
      throw new BadRequestException(
        'The uploaded document is a Statement of Account or Tuition Fee Assessment. Please upload your Proof of Enrolled Subjects (Certificate of Registration / Class Schedule) in this input, or switch to Consolidated mode if your form contains both.',
      );
    }
    const rawSubjects = Array.isArray(raw.subjects) ? raw.subjects : [];
    if (raw.detected_document_type === 'OTHER' || rawSubjects.length === 0) {
      throw new BadRequestException(
        'The uploaded document does not appear to be an official Certificate of Registration or Class Schedule. Please upload a valid enrollment document.',
      );
    }

    const subjects: ExtractedCorSubject[] = rawSubjects
      .map((s: any) => this.sanitizeSubject(s))
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

    const parsedTotalUnits = this.sanitizeAmount(raw.total_units);
    const totalUnits =
      parsedTotalUnits && parsedTotalUnits > 0
        ? parsedTotalUnits
        : academicSubjects.reduce((sum, s) => sum + s.units, 0);

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      course_name: raw.course_name,
      academic_year: this.normalizeAcademicYear(
        raw.academic_year,
        raw.semester,
      ),
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
    const raw = await this.extractRawSafely(
      'Statement of Account (SOA)',
      'We could not read a valid Statement of Account or Tuition Assessment from this file. Please upload a clear PDF or image of your official SOA / Student Ledger.',
      () => this.llamaExtractService.extractEnrollmentSoaData(input),
    );

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

    const billing = this.extractBillingFields(raw);

    if (billing.totalAssessment <= 0 && !billing.hasFeeBreakdown) {
      throw new BadRequestException(
        'No tuition assessment balance or fee charges were detected in the uploaded file. Please upload an official Statement of Account (SOA), Tuition Fee Assessment, or Student Ledger.',
      );
    }

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      academic_year: this.normalizeAcademicYear(
        raw.academic_year,
        raw.semester,
      ),
      semester: this.normalizeSemester(raw.semester),
      assessment_date: raw.assessment_date,
      total_assessment: billing.totalAssessment,
      tuition_fee: billing.tuition_fee,
      lab_fees: billing.lab_fees,
      misc_fees: billing.misc_fees,
      other_fees: billing.other_fees,
      previous_balance: billing.previous_balance,
      discounts: billing.discounts,
      net_balance_due: billing.net_balance_due,
    };
  }

  async parseConsolidated(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedConsolidatedData> {
    this.logger.log(
      'Dispatching Consolidated COR+SOA document to LlamaExtract...',
    );
    const raw = await this.extractRawSafely(
      'Consolidated Enrollment & Assessment Form',
      'We could not read a valid Consolidated Enrollment & Assessment Form from this file. Please upload a clear PDF or image containing both your enrolled subjects and tuition fees.',
      () => this.llamaExtractService.extractConsolidatedEnrollmentData(input),
    );

    if (raw.detected_document_type === 'OTHER') {
      throw new BadRequestException(
        'The uploaded document does not appear to be an official Consolidated Enrollment & Assessment Form. Please upload a valid matriculation document showing both enrolled subjects and tuition fees.',
      );
    }

    const rawSubjects = Array.isArray(raw.subjects) ? raw.subjects : [];
    const subjects: ExtractedCorSubject[] = rawSubjects
      .map((s: any) => this.sanitizeSubject(s))
      .filter((s: ExtractedCorSubject) => Boolean(s.subject_code));

    if (subjects.length === 0) {
      throw new BadRequestException(
        'No enrolled subjects found in the consolidated document. Please ensure your form contains both your registered courses and tuition assessment.',
      );
    }

    const billing = this.extractBillingFields(raw);
    if (billing.totalAssessment <= 0 && !billing.hasFeeBreakdown) {
      throw new BadRequestException(
        'No tuition assessment balance found in the consolidated document. If your school issues separate documents for class schedule and tuition billing, please turn off Consolidated mode.',
      );
    }

    const parsedTotalUnits = this.sanitizeAmount(raw.total_units);
    const totalUnits =
      parsedTotalUnits && parsedTotalUnits > 0
        ? parsedTotalUnits
        : subjects.reduce((sum, s) => sum + s.units, 0);

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      course_name: raw.course_name,
      academic_year: this.normalizeAcademicYear(
        raw.academic_year,
        raw.semester,
      ),
      semester: this.normalizeSemester(raw.semester),
      year_level: this.normalizeYearLevel(raw.year_level),
      total_units: totalUnits,
      assessment_date: raw.assessment_date,
      total_assessment: billing.totalAssessment,
      tuition_fee: billing.tuition_fee,
      lab_fees: billing.lab_fees,
      misc_fees: billing.misc_fees,
      other_fees: billing.other_fees,
      previous_balance: billing.previous_balance,
      discounts: billing.discounts,
      net_balance_due: billing.net_balance_due,
      subjects,
    };
  }
}
