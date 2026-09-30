/**
 * Pure calculation utilities for Scholar GWA calculation and health evaluation across diverse grading scales.
 */

/**
 * Calculates GWA for a scholar based on latest grade report, or prospectus subjects, or school scale fallback.
 */
export function calculateScholarGwa(
  scholar: any,
  gradeThreshold: number,
): number {
  const latestReport = scholar.grade_reports?.[0];
  if (latestReport && latestReport.gpa != null && !isNaN(Number(latestReport.gpa))) {
    return Number(latestReport.gpa);
  }

  const subjects = scholar.prospectus?.subjects;
  if (subjects?.length) {
    const graded = subjects.filter(
      (s: any) => s.grade != null && !isNaN(Number(s.grade)),
    );
    if (graded.length > 0) {
      const totalWeighted = graded.reduce(
        (acc: number, s: any) =>
          acc + Number(s.grade) * (Number(s.units) || 3),
        0,
      );
      const totalUnits = graded.reduce(
        (acc: number, s: any) => acc + (Number(s.units) || 3),
        0,
      );
      return totalUnits > 0
        ? Number((totalWeighted / totalUnits).toFixed(2))
        : Number(graded[0].grade);
    }
  }

  const gradingSystem = scholar.school_grading_system;
  if (gradingSystem?.highest_grade) {
    return Number(gradingSystem.highest_grade);
  }

  if (gradingSystem?.grading_scale === 'NUMERIC_5_POINT') {
    return 1.0;
  }

  if (gradingSystem?.grading_scale === 'NUMERIC_4_POINT') {
    return 4.0;
  }

  return gradeThreshold;
}

/**
 * Evaluates if computed GWA meets retention threshold across different grading scales.
 * e.g., A 90% threshold translates to:
 * - 90.00 on a 100% percentage scale
 * - 3.50 on UM's 4.0 scale (where 2.0 = 75%, 4.0 = 100%, 3.50 = 90%)
 * - 1.80 on USEP / UP 5.0 scale (where 3.0 = 75%, 1.0 = 100%, 1.80 = 90%)
 */
export function evaluateGwaThreshold(
  gwa: number,
  globalThresholdPercent: number,
  schoolConfig?: any,
): boolean {
  if (!schoolConfig || schoolConfig.grading_scale === 'PERCENTAGE_100') {
    return gwa >= globalThresholdPercent;
  }

  const highest = Number(schoolConfig.highest_grade ?? 1.0);
  const passing = Number(schoolConfig.passing_grade ?? 3.0);
  const failing = Number(schoolConfig.failing_grade ?? 5.0);

  const normalizedPercent = Math.max(
    75,
    Math.min(100, globalThresholdPercent),
  );

  if (highest < failing) {
    // Inverted 5-point scale (e.g. 1.0 highest, 3.0 passing at 75%)
    // 90% translates to: 3.0 - ((90 - 75) / 25) * (3.0 - 1.0) = 1.80
    const thresholdGwa =
      passing - ((normalizedPercent - 75) / 25) * (passing - highest);
    return gwa <= Number(thresholdGwa.toFixed(2));
  } else {
    // Ascending scale (e.g. UM 4.0: 4.0 highest, 2.0 passing at 75%, 3.50 retention at 90%)
    const thresholdGwa =
      normalizedPercent <= 90
        ? passing + ((normalizedPercent - 75) / 15) * 1.5
        : 3.5 + ((normalizedPercent - 90) / 10) * (highest - 3.5);
    return gwa >= Number(thresholdGwa.toFixed(2));
  }
}

/**
 * Determines scholar health standing ('good' | 'warn' | 'bad') based on probation status,
 * grade flags, and GWA compliance with school retention thresholds.
 */
export function evaluateScholarHealth(
  gwa: number,
  scholar: any,
  latestReport: any,
  globalThresholdPercent: number,
): 'good' | 'warn' | 'bad' {
  const isOnProbation =
    scholar.academic_baseline_status === 'ON_PROBATION' ||
    latestReport?.appeal_status === 'APPROVED';

  const isFlagged =
    latestReport &&
    (latestReport.status === 'FLAGGED' ||
      latestReport.evaluation_flag === 'ACADEMIC_FAILURE' ||
      latestReport.evaluation_flag === 'BELOW_PASSING_MARK' ||
      latestReport.is_eligible === false);

  const schoolConfig = scholar.school_grading_system;
  const highest = Number(
    schoolConfig?.highest_grade ??
      (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
        ? 1.0
        : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
          ? 4.0
          : 100),
  );
  const passing = Number(
    schoolConfig?.passing_grade ??
      (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
        ? 3.0
        : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
          ? 2.0
          : 75),
  );
  const failing = Number(
    schoolConfig?.failing_grade ??
      (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
        ? 5.0
        : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
          ? 1.0
          : 50),
  );

  const isInverted = highest < failing;
  const isFailingGrade = isInverted ? gwa > passing : gwa < passing;

  const meetsRetention = evaluateGwaThreshold(
    gwa,
    globalThresholdPercent,
    schoolConfig,
  );

  if (isFlagged || (gwa > 0 && isFailingGrade)) {
    return 'bad';
  } else if (isOnProbation || (gwa > 0 && !meetsRetention)) {
    return 'warn';
  }
  return 'good';
}
