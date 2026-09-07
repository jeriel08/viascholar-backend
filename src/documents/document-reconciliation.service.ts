import { Injectable } from '@nestjs/common';
import { ForensicMetadataResult } from './file-forensics.service.js';
import { GradeCalculatorService } from './grade-calculator.service.js';

export type ForensicRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ForensicEvaluationResult {
  is_flagged: boolean;
  risk_level: ForensicRiskLevel;
  flags: string[];
  summary: string;
  math_reconciliation?: {
    reported_gwa?: number;
    calculated_gwa?: number;
    difference?: number;
    is_consistent: boolean;
  };
  metadata_forensics?: ForensicMetadataResult;
}

interface RawExtractedGrade {
  subject_code?: string;
  subject_name?: string;
  units?: number | string;
  grade?: number | string;
  semester?: string;
  [key: string]: unknown;
}

interface RawExtractedData {
  label?: string;
  general_average?: number | string;
  first_sem_average?: number | string;
  first_semester_average?: number | string;
  sem1_average?: number | string;
  first_sem_gwa?: number | string;
  second_sem_average?: number | string;
  second_semester_average?: number | string;
  sem2_average?: number | string;
  second_sem_gwa?: number | string;
  grades?: unknown[];
  student_name?: string;
  name?: string;
  course_name?: string;
  has_signature?: boolean | string;
  [key: string]: unknown;
}

interface ScholarProfileInput {
  first_name?: string | null;
  last_name?: string | null;
  course_of_study?: string | null;
}

@Injectable()
export class DocumentReconciliationService {
  constructor(private gradeCalculatorService: GradeCalculatorService) {}

  /**
   * Reconciles OCR-extracted data against mathematical invariants, student profile, and signatures.
   */
  evaluateExtractedDocument(
    profile: ScholarProfileInput | null | undefined,
    documentType: string,
    extractedData: RawExtractedData,
    initialMetadataForensics?: ForensicMetadataResult,
  ): ForensicEvaluationResult {
    const flags: string[] = [...(initialMetadataForensics?.flags || [])];
    const rawGrades = Array.isArray(extractedData.grades)
      ? (extractedData.grades as RawExtractedGrade[])
      : [];

    // Only include subjects that have actual numeric grades recorded
    const grades = rawGrades.filter(
      (g) => g.grade != null && !isNaN(Number(g.grade)) && Number(g.grade) > 0,
    );

    const isForm138 = this.gradeCalculatorService.isForm138(
      documentType,
      extractedData.label,
    );

    // 1. Math Reconciliation & Semester-Aware Verification
    let mathResult: ForensicEvaluationResult['math_reconciliation'];
    const reportedGwaRaw = extractedData.general_average;
    const reportedGwa =
      reportedGwaRaw != null && !isNaN(Number(reportedGwaRaw))
        ? Number(reportedGwaRaw)
        : undefined;

    // Check for explicit 1st & 2nd semester averages (from Parseur fields or computed from semester-tagged subjects)
    const sem1Raw =
      extractedData.first_sem_average ??
      extractedData.first_semester_average ??
      extractedData.sem1_average ??
      extractedData.first_sem_gwa;
    const sem2Raw =
      extractedData.second_sem_average ??
      extractedData.second_semester_average ??
      extractedData.sem2_average ??
      extractedData.second_sem_gwa;

    let sem1 =
      sem1Raw != null && !isNaN(Number(sem1Raw)) ? Number(sem1Raw) : null;
    let sem2 =
      sem2Raw != null && !isNaN(Number(sem2Raw)) ? Number(sem2Raw) : null;

    // Fallback: If not explicitly extracted, calculate sem1 and sem2 averages from semester-tagged subjects
    if (sem1 == null || sem2 == null) {
      const sem1Items = grades.filter((g) =>
        /1st|first/i.test(g.semester || ''),
      );
      const sem2Items = grades.filter((g) =>
        /2nd|second/i.test(g.semester || ''),
      );
      if (sem1Items.length > 0 && sem1 == null) {
        sem1 =
          sem1Items.reduce((acc, i) => acc + Number(i.grade), 0) /
          sem1Items.length;
      }
      if (sem2Items.length > 0 && sem2 == null) {
        sem2 =
          sem2Items.reduce((acc, i) => acc + Number(i.grade), 0) /
          sem2Items.length;
      }
    }

    if (grades.length > 0 || (sem1 != null && sem2 != null)) {
      let computedGwa = 0;

      if (grades.length > 0) {
        const computation = this.gradeCalculatorService.computeGwa({
          gradeItems: grades.map((g) => ({
            subject_code: g.subject_code,
            subject_name: g.subject_name,
            units: g.units != null ? Number(g.units) : 1,
            grade: Number(g.grade),
          })),
          isForm138,
        });
        computedGwa = computation.computedGwa;
      } else if (sem1 != null && sem2 != null) {
        computedGwa = (sem1 + sem2) / 2;
      }

      if (
        reportedGwa != null &&
        (computedGwa > 0 || (sem1 != null && sem2 != null))
      ) {
        let diff = Math.abs(reportedGwa - computedGwa);

        // Check if reported GWA matches the mean of the 2 semestral averages (with DepEd rounding)
        if (sem1 != null && sem2 != null) {
          const semMean = (sem1 + sem2) / 2;
          const semDiff = Math.abs(reportedGwa - semMean);
          if (semDiff < diff) {
            diff = semDiff;
          }
        }

        // Calibrated Tolerances:
        // On 100% scale: <= 1.5 pts is normal (DepEd semestral rounding or minor quarter averaging).
        // On 5.0 scale: <= 0.15 is normal.
        const isNumericScale = computedGwa <= 5.0 && computedGwa > 0;
        const normalTolerance = isNumericScale ? 0.15 : 1.5;
        const moderateTolerance = isNumericScale ? 0.35 : 3.5;

        const isConsistent = diff <= normalTolerance;

        if (!isConsistent) {
          if (diff <= moderateTolerance) {
            flags.push('MODERATE_MATH_VARIANCE');
          } else {
            flags.push('SEVERE_MATH_DISCREPANCY');
          }
        }

        mathResult = {
          reported_gwa: Number(reportedGwa.toFixed(2)),
          calculated_gwa: Number(computedGwa.toFixed(2)),
          difference: Number(diff.toFixed(2)),
          is_consistent: isConsistent,
        };
      }
    }

    // 2. Impossible Grade Range Validation
    for (const g of grades) {
      const val = Number(g.grade);
      if (val > 100 || (val > 5.0 && val < 50)) {
        flags.push('ANOMALOUS_GRADE_VALUE_DETECTED');
        break;
      }
    }

    // 3. Student Identity Matching
    if (profile) {
      const extractedName = String(
        extractedData.student_name || extractedData.name || '',
      ).toLowerCase();
      const firstName = (profile.first_name || '').toLowerCase();
      const lastName = (profile.last_name || '').toLowerCase();

      if (extractedName.length > 3 && (firstName || lastName)) {
        const hasFirst = firstName && extractedName.includes(firstName);
        const hasLast = lastName && extractedName.includes(lastName);
        if (!hasFirst && !hasLast) {
          flags.push('STUDENT_NAME_MISMATCH');
        }
      }

      // Only check course mismatch for College TOR / Grade Slips (Skip for High School Form 138)
      if (!isForm138 && profile.course_of_study && extractedData.course_name) {
        const extractedCourse = String(extractedData.course_name).toLowerCase();
        const registeredCourse = profile.course_of_study.toLowerCase();
        if (
          !extractedCourse.includes(registeredCourse) &&
          !registeredCourse.includes(extractedCourse)
        ) {
          flags.push('COURSE_MISMATCH');
        }
      }
    }

    // 4. Registrar Signature / Seal Check
    const hasSig =
      String(extractedData.has_signature).toLowerCase() === 'true' ||
      extractedData.has_signature === true;
    if (extractedData.has_signature != null && !hasSig) {
      flags.push('MISSING_REGISTRAR_SIGNATURE');
    }

    const uniqueFlags = Array.from(new Set(flags));

    // 5. Risk Level Calculation
    let riskLevel: ForensicRiskLevel = 'LOW';
    const highRiskFlags = [
      'SEVERE_MATH_DISCREPANCY',
      'SUSPICIOUS_SOFTWARE_PHOTOSHOP',
      'SUSPICIOUS_SOFTWARE_CANVA',
      'SUSPICIOUS_SOFTWARE_PHOTOPEA',
      'SUSPICIOUS_SOFTWARE_GIMP',
      'ANOMALOUS_GRADE_VALUE_DETECTED',
    ];
    const mediumRiskFlags = [
      'MODERATE_MATH_VARIANCE',
      'STUDENT_NAME_MISMATCH',
      'MISSING_REGISTRAR_SIGNATURE',
      'PDF_MODIFIED_LONG_AFTER_CREATION',
      'COURSE_MISMATCH',
    ];

    if (uniqueFlags.some((f) => highRiskFlags.includes(f))) {
      riskLevel = 'HIGH';
    } else if (uniqueFlags.some((f) => mediumRiskFlags.includes(f))) {
      riskLevel = 'MEDIUM';
    }

    // Friendly human-readable summary for Coordinators
    let summary =
      'Document passed forensic baseline check with zero tampering indicators.';
    const detectedSoft = initialMetadataForensics?.detected_software || [];

    if (detectedSoft.length > 0) {
      summary = `High tampering risk: Document asset contains signatures of graphic editing tool (${detectedSoft.join(', ')}).`;
    } else if (uniqueFlags.includes('SEVERE_MATH_DISCREPANCY')) {
      summary = `High risk discrepancy: Reported GWA (${mathResult?.reported_gwa}) deviates significantly from calculated subject average (${mathResult?.calculated_gwa}).`;
    } else if (uniqueFlags.includes('MODERATE_MATH_VARIANCE')) {
      summary = `Review advisory: Slight difference (${mathResult?.difference} pts) between printed GWA (${mathResult?.reported_gwa}) and subject grades (${mathResult?.calculated_gwa}). Likely due to semester weighting or non-credit subjects.`;
    } else if (uniqueFlags.includes('STUDENT_NAME_MISMATCH')) {
      summary = `Review advisory: Extracted student name does not closely match registered profile name.`;
    } else if (uniqueFlags.includes('MISSING_REGISTRAR_SIGNATURE')) {
      summary = `Review advisory: Official registrar signature or dry seal was not clearly detected.`;
    }

    return {
      is_flagged: riskLevel !== 'LOW',
      risk_level: riskLevel,
      flags: uniqueFlags,
      summary,
      math_reconciliation: mathResult,
      metadata_forensics: initialMetadataForensics,
    };
  }
}
