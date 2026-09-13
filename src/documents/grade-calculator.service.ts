import { Injectable } from '@nestjs/common';
import { SchoolGradingSystem } from '../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';

export interface EvaluatedGradeItem {
  subject_code?: string;
  subject_name?: string;
  units?: number;
  grade: number;
}

export interface GwaComputationResult {
  computedGwa: number;
  hasFailedGrade: boolean;
  totalUnits: number;
}

@Injectable()
export class GradeCalculatorService {
  constructor(private settingsService: SettingsService) {}

  /**
   * Identifies whether the document is a High School Form 138 / 137 / Report Card
   */
  isForm138(documentType?: string, label?: string): boolean {
    const matcher = /138|137|form\s*9|sf9|report\s*card|high\s*school|shs|senior\s*high/i;
    return matcher.test(documentType || '') || matcher.test(label || '');
  }

  /**
   * Computes the general weighted average or arithmetic mean based on document type
   * and checks for failed grades against school grading policies.
   */
  computeGwa(params: {
    gradeItems: EvaluatedGradeItem[];
    isForm138: boolean;
    explicitGeneralAvg?: number;
    schoolConfig?: SchoolGradingSystem | null;
  }): GwaComputationResult {
    const { gradeItems, isForm138, explicitGeneralAvg, schoolConfig } = params;

    let computedGwa = 0;
    let totalUnits = 0;
    let weightedSum = 0;
    let hasFailedGrade = false;

    if (explicitGeneralAvg != null && !isNaN(explicitGeneralAvg)) {
      computedGwa = explicitGeneralAvg;
      for (const item of gradeItems) {
        const grade = Number(item.grade);
        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        } else if (isForm138 && grade < 75.0) {
          // Standard Philippine high school passing mark is 75.0
          hasFailedGrade = true;
        }
      }
    } else if (isForm138) {
      // High School Form 138: Deduplicate MAPEH components if parent MAPEH is present
      const hasMapeh = gradeItems.some((i) =>
        /^mapeh$/i.test(String(i.subject_code || i.subject_name || '')),
      );
      const mapehSubSubjects = /^(music|arts|physical education|pe|health)$/i;

      const coreItems = hasMapeh
        ? gradeItems.filter(
            (i) =>
              !mapehSubSubjects.test(String(i.subject_name || '')) &&
              !mapehSubSubjects.test(String(i.subject_code || '')),
          )
        : gradeItems;

      let sum = 0;
      for (const item of coreItems) {
        const grade = Number(item.grade);
        sum += grade;
        if (grade < 75.0) {
          hasFailedGrade = true;
        }
      }
      computedGwa = coreItems.length > 0 ? sum / coreItems.length : 0;
    } else {
      // College TOR / Certificate of Grades: Weighted by credit units
      for (const item of gradeItems) {
        const units = item.units != null ? Number(item.units) : 1;
        const grade = Number(item.grade);
        totalUnits += units;
        weightedSum += grade * units;

        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        }
      }
      computedGwa = totalUnits > 0 ? weightedSum / totalUnits : 0;
    }

    return {
      computedGwa,
      hasFailedGrade,
      totalUnits,
    };
  }

  /**
   * Normalizes extracted academic year string into standard format (e.g., '2024-2025')
   */
  normalizeAcademicYear(rawAcademicYear?: string): string {
    if (!rawAcademicYear || typeof rawAcademicYear !== 'string') {
      return 'AY';
    }
    return (
      rawAcademicYear.match(/\d{4}\s*-\s*\d{4}/)?.[0]?.replace(/\s+/g, '') ??
      rawAcademicYear.slice(0, 15) ??
      'AY'
    );
  }

  /**
   * Normalizes semester representation based on academic year and document hints
   */
  normalizeSemester(
    extractedSemester?: unknown,
    rawAcademicYear?: string,
    isForm138 = false,
  ): string {
    const ay = typeof rawAcademicYear === 'string' ? rawAcademicYear : '';
    if (typeof extractedSemester === 'string' && extractedSemester.trim()) {
      return extractedSemester;
    }
    if (isForm138 && !/semester|sem/i.test(ay)) {
      return 'Annual';
    }
    if (/2nd/i.test(ay)) {
      return '2nd Semester';
    }
    if (/summer|midyear/i.test(ay)) {
      return 'Summer';
    }
    return '1st Semester';
  }
}
