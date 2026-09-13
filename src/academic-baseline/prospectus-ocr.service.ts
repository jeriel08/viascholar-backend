import { Injectable, Logger } from '@nestjs/common';
import { LlamaExtractService } from '../documents/extractors/llama-extract.service.js';
import { InputDocumentFile } from '../documents/extractors/document-extractor.interface.js';

export interface NormalizedProspectusSubject {
  subject_code: string;
  descriptive_title: string;
  units: number;
  year_level: number;
  semester: string;
  prerequisites: string[];
}

export interface NormalizedProspectusData {
  course_name?: string;
  course_code?: string;
  curriculum_year?: string;
  total_units?: number;
  subjects: NormalizedProspectusSubject[];
}

export interface ExtractedHistoricalCourse {
  subject_code: string;
  subject_name?: string;
  units?: number;
  grade: number;
  raw_status?: string;
  semester?: string;
}

@Injectable()
export class ProspectusOcrService {
  private readonly logger = new Logger(ProspectusOcrService.name);

  constructor(
    private readonly llamaExtractService: LlamaExtractService,
  ) {}

  /**
   * Cleans and standardizes subject codes for robust fuzzy matching (e.g. "IT - 101 A" -> "IT101A")
   */
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

  /**
   * Normalizes semester strings into standard enum-like values
   */
  normalizeSemester(sem: string): string {
    if (!sem) return '1st Semester';
    const lower = sem.toLowerCase();
    if (lower.includes('summer') || lower.includes('midyear')) return 'Summer';
    if (lower.includes('2nd') || lower.includes('second')) return '2nd Semester';
    if (lower.includes('3rd') || lower.includes('third')) return '3rd Trimester';
    return '1st Semester';
  }

  /**
   * Normalizes year level (e.g. "1st Year", 1 -> 1)
   */
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

  /**
   * Extracts and standardizes prospectus checklist from uploaded PDF/Image files
   */
  async processProspectusExtraction(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<NormalizedProspectusData> {
    this.logger.log('Dispatching uploaded files to LlamaExtract for Prospectus parsing...');
    const rawData = await this.llamaExtractService.extractProspectusData(input);

    const normalizedSubjects: NormalizedProspectusSubject[] = [];
    let calculatedUnits = 0;

    for (const sub of rawData.subjects || []) {
      const cleanCode = (sub.subject_code || '').trim().toUpperCase();
      if (!cleanCode) continue;

      const cleanTitle = (sub.descriptive_title || cleanCode).trim();
      const units = Number(sub.units) > 0 ? Number(sub.units) : 3.0;
      const yearLevel = this.normalizeYearLevel(sub.year_level);
      const semester = this.normalizeSemester(sub.semester);
      const prereqs = Array.isArray(sub.prerequisites)
        ? sub.prerequisites.map((p) => String(p).trim()).filter(Boolean)
        : [];

      calculatedUnits += units;

      normalizedSubjects.push({
        subject_code: cleanCode,
        descriptive_title: cleanTitle,
        units,
        year_level: yearLevel,
        semester,
        prerequisites: prereqs,
      });
    }

    const finalTotalUnits =
      rawData.total_units != null && Number(rawData.total_units) > 0
        ? Number(rawData.total_units)
        : Number(calculatedUnits.toFixed(1));

    return {
      course_name: rawData.course_name || 'Degree Program',
      course_code: rawData.course_code || undefined,
      curriculum_year: rawData.curriculum_year || 'Current Catalog',
      total_units: finalTotalUnits,
      subjects: normalizedSubjects,
    };
  }

  /**
   * Extracts historical grade entries from past TOR or CCG files
   */
  async processHistoricalCcgExtraction(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedHistoricalCourse[]> {
    this.logger.log('Dispatching historical CCG/TOR document for grade extraction...');
    const rawData = await this.llamaExtractService.extractData(input, 'Historical TOR / Certified Copy of Grades');

    const rawGrades = Array.isArray(rawData.grades) ? rawData.grades : [];
    const historicalCourses: ExtractedHistoricalCourse[] = [];

    for (const g of rawGrades as any[]) {
      const code = (g.subject_code || '').trim().toUpperCase();
      const grade = Number(g.grade);

      if (code && !isNaN(grade)) {
        historicalCourses.push({
          subject_code: code,
          subject_name: (g.subject_name || '').trim() || undefined,
          units: g.units != null ? Number(g.units) : undefined,
          grade,
          raw_status: g.raw_status || undefined,
          semester: g.semester || undefined,
        });
      }
    }

    return historicalCourses;
  }
}
