import { Injectable } from '@nestjs/common';
import { SchoolGradingSystem } from '../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';

export interface EvaluatedGradeItem {
  subject_code?: string;
  subject_name?: string;
  units?: number;
  grade: number | string;
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
        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            item.grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        } else {
          const numGrade = Number(item.grade);
          if (!isNaN(numGrade) && isForm138 && numGrade < 75.0) {
            hasFailedGrade = true;
          }
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
      let numericCount = 0;
      for (const item of coreItems) {
        const numGrade = Number(item.grade);
        if (!isNaN(numGrade)) {
          sum += numGrade;
          numericCount++;
        }

        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            item.grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        } else if (!isNaN(numGrade) && numGrade < 75.0) {
          hasFailedGrade = true;
        }
      }
      computedGwa = numericCount > 0 ? sum / numericCount : 0;
    } else {
      // College TOR / Certificate of Grades: Weighted by credit units
      for (const item of gradeItems) {
        const numGrade = Number(item.grade);
        const units = item.units != null ? Number(item.units) : 1;

        if (schoolConfig) {
          const evaluation = this.settingsService.evaluateStudentGrade(
            item.grade,
            schoolConfig,
          );
          if (!evaluation.isPassing) {
            hasFailedGrade = true;
          }
        } else if (!isNaN(numGrade)) {
          // Default fallback: 3.0 passing on 5.0 scale or 75.0 on 100% scale
          if (numGrade > 3.0 && numGrade <= 5.0) {
            hasFailedGrade = true;
          }
        }

        // Only include numerical marks in weighted GWA (exclude non-numerical codes like PSD, P, TWE, INC)
        if (!isNaN(numGrade) && String(item.grade).trim() !== '') {
          totalUnits += units;
          weightedSum += numGrade * units;
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

  /**
   * Normalizes any school-specific GWA to a universal 0-100% equivalent.
   * - DepEd / Form 138 (75-100%): Direct value.
   * - Inverse 5-point (USEP/UP/ADDU: 1.00 highest, 3.00 passing=75%): Linear map to 100-75%.
   * - Direct 4-point (UM: 4.00 highest, 2.00 passing=75%, 1.00 failing=50%): Linear map to 100-75%.
   */
  normalizeGwaToPercentage(
    gwa: number,
    schoolConfig?: SchoolGradingSystem | null,
    isForm138 = false,
  ): number {
    if (gwa == null || isNaN(gwa)) return 0;

    if (isForm138 || !schoolConfig || schoolConfig.grading_scale === 'PERCENTAGE_100') {
      return Number(Math.min(100, Math.max(0, gwa)).toFixed(2));
    }

    const highest = Number(schoolConfig.highest_grade ?? 1.0);
    const passing = Number(schoolConfig.passing_grade ?? 3.0);
    const failing = Number(schoolConfig.failing_grade ?? 5.0);

    if (highest < failing) {
      // Inverted 5-point scale (e.g. 1.00 = 100%, 3.00 = 75%)
      if (gwa <= highest) return 100.0;
      if (gwa <= passing) {
        const score = 100 - ((gwa - highest) / (passing - highest)) * 25;
        return Number(Math.min(100, Math.max(75, score)).toFixed(2));
      }
      const failRange = Math.abs(failing - passing) || 2.0;
      const score = 75 - ((gwa - passing) / failRange) * 25;
      return Number(Math.min(74.99, Math.max(0, score)).toFixed(2));
    } else {
      // Direct 4-point scale (e.g. UM: 4.00 = 100%, 2.00 = 75%, 1.00 = 50%)
      if (gwa >= highest) return 100.0;
      if (gwa >= passing) {
        const score = 75 + ((gwa - passing) / (highest - passing)) * 25;
        return Number(Math.min(100, Math.max(75, score)).toFixed(2));
      }
      const failRange = Math.abs(passing - failing) || 1.0;
      const score = 75 - ((passing - gwa) / failRange) * 25;
      return Number(Math.min(74.99, Math.max(0, score)).toFixed(2));
    }
  }
}
