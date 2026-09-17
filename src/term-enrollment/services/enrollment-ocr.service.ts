import { Injectable, Logger } from '@nestjs/common';
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
    if (lower.includes('2nd') || lower.includes('second')) return '2nd Semester';
    if (lower.includes('3rd') || lower.includes('third')) return '3rd Trimester';
    return '1st Semester';
  }

  normalizeYearLevel(year: any): number {
    if (typeof year === 'number' && year >= 1 && year <= 6) return Math.floor(year);
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

  async parseCor(input: InputDocumentFile | InputDocumentFile[]): Promise<ExtractedCorData> {
    this.logger.log('Dispatching COR document to LlamaExtract...');
    const raw = await this.llamaExtractService.extractEnrollmentCorData(input);

    const subjects: ExtractedCorSubject[] = (raw.subjects || []).map((s: any) => ({
      subject_code: (s.subject_code || '').trim().toUpperCase(),
      descriptive_title: (s.descriptive_title || s.subject_code || '').trim(),
      section: s.section ? String(s.section).trim() : undefined,
      schedule: s.schedule ? String(s.schedule).trim() : undefined,
      room: s.room ? String(s.room).trim() : undefined,
      units: Number(s.units) > 0 ? Number(s.units) : 3.0,
    })).filter((s: ExtractedCorSubject) => Boolean(s.subject_code));

    const totalUnits = Number(raw.total_units) > 0
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
      subjects,
    };
  }

  async parseSoa(input: InputDocumentFile | InputDocumentFile[]): Promise<ExtractedSoaData> {
    this.logger.log('Dispatching SOA document to LlamaExtract...');
    const raw = await this.llamaExtractService.extractEnrollmentSoaData(input);

    return {
      student_name: raw.student_name,
      student_number: raw.student_number,
      school_name: raw.school_name,
      academic_year: raw.academic_year,
      semester: this.normalizeSemester(raw.semester),
      assessment_date: raw.assessment_date,
      total_assessment: Number(raw.total_assessment) || 0,
      tuition_fee: raw.tuition_fee != null ? Number(raw.tuition_fee) : undefined,
      lab_fees: raw.lab_fees != null ? Number(raw.lab_fees) : undefined,
      misc_fees: raw.misc_fees != null ? Number(raw.misc_fees) : undefined,
      other_fees: raw.other_fees != null ? Number(raw.other_fees) : undefined,
      previous_balance: raw.previous_balance != null ? Number(raw.previous_balance) : undefined,
      discounts: raw.discounts != null ? Number(raw.discounts) : undefined,
      net_balance_due: raw.net_balance_due != null ? Number(raw.net_balance_due) : Number(raw.total_assessment) || 0,
    };
  }

  async parseConsolidated(input: InputDocumentFile | InputDocumentFile[]): Promise<ExtractedConsolidatedData> {
    this.logger.log('Dispatching Consolidated COR+SOA document to LlamaExtract...');
    const raw = await this.llamaExtractService.extractConsolidatedEnrollmentData(input);

    const subjects: ExtractedCorSubject[] = (raw.subjects || []).map((s: any) => ({
      subject_code: (s.subject_code || '').trim().toUpperCase(),
      descriptive_title: (s.descriptive_title || s.subject_code || '').trim(),
      section: s.section ? String(s.section).trim() : undefined,
      schedule: s.schedule ? String(s.schedule).trim() : undefined,
      room: s.room ? String(s.room).trim() : undefined,
      units: Number(s.units) > 0 ? Number(s.units) : 3.0,
    })).filter((s: ExtractedCorSubject) => Boolean(s.subject_code));

    const totalUnits = Number(raw.total_units) > 0
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
      total_assessment: Number(raw.total_assessment) || 0,
      tuition_fee: raw.tuition_fee != null ? Number(raw.tuition_fee) : undefined,
      lab_fees: raw.lab_fees != null ? Number(raw.lab_fees) : undefined,
      misc_fees: raw.misc_fees != null ? Number(raw.misc_fees) : undefined,
      other_fees: raw.other_fees != null ? Number(raw.other_fees) : undefined,
      previous_balance: raw.previous_balance != null ? Number(raw.previous_balance) : undefined,
      discounts: raw.discounts != null ? Number(raw.discounts) : undefined,
      net_balance_due: raw.net_balance_due != null ? Number(raw.net_balance_due) : Number(raw.total_assessment) || 0,
      subjects,
    };
  }
}
