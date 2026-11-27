export interface ProspectusSubjectSnapshot {
  status?: string | null;
  units?: unknown;
  year_level?: number | null;
}

export interface ProspectusSnapshot {
  is_frozen?: boolean | null;
  subjects?: ProspectusSubjectSnapshot[] | null;
}

export interface ProspectusGraduationEvaluation {
  hasProspectus: boolean;
  isFrozen: boolean;
  totalSubjects: number;
  completedSubjects: number;
  remainingSubjects: number;
  totalUnits: number;
  completedUnits: number;
  remainingUnits: number;
  completionPct: number;
  maxCurriculumYear: number;
  isGraduating: boolean;
  isReadyForGraduation: boolean;
}

const COMPLETED_STATUSES = new Set(['PASSED', 'CREDITED']);

/**
 * Evaluates prospectus completion percentage, effective graduation threshold year
 * (supports 4-year and 5-year curricula, falling back to year 4 when no prospectus exists),
 * and whether an active scholar with a frozen prospectus is 100% ready for graduation confirmation.
 */
export function evaluateProspectusGraduation(
  prospectus: ProspectusSnapshot | null | undefined,
  currentYearLevel?: number | null,
  isArchived = false,
): ProspectusGraduationEvaluation {
  const subjects = Array.isArray(prospectus?.subjects)
    ? prospectus.subjects
    : [];
  const hasProspectus = Boolean(prospectus && subjects.length > 0);
  const isFrozen = Boolean(prospectus?.is_frozen);

  let totalUnits = 0;
  let completedUnits = 0;
  let remainingUnits = 0;
  let completedSubjects = 0;
  let remainingSubjects = 0;
  let maxYearFound = 0;

  for (const subject of subjects) {
    const units = Number(subject.units);
    const safeUnits = Number.isFinite(units) && units > 0 ? units : 0;
    totalUnits += safeUnits;

    const yr = Number(subject.year_level);
    if (Number.isFinite(yr) && yr > maxYearFound) {
      maxYearFound = Math.trunc(yr);
    }

    const status = (subject.status || '').trim().toUpperCase();
    if (COMPLETED_STATUSES.has(status)) {
      completedSubjects += 1;
      completedUnits += safeUnits;
    } else {
      remainingSubjects += 1;
      remainingUnits += safeUnits;
    }
  }

  const totalSubjects = subjects.length;
  let completionPct = 0;
  if (totalSubjects > 0) {
    if (totalUnits > 0) {
      completionPct = Math.min(
        100,
        Math.round((completedUnits / totalUnits) * 100),
      );
    } else {
      completionPct = Math.min(
        100,
        Math.round((completedSubjects / totalSubjects) * 100),
      );
    }
  }

  const maxCurriculumYear = maxYearFound > 0 ? Math.max(4, maxYearFound) : 4;
  const isReadyForGraduation = Boolean(
    !isArchived && isFrozen && totalSubjects > 0 && remainingSubjects === 0,
  );
  const effectiveYearLevel = Number(currentYearLevel) || 1;
  const isGraduating =
    isReadyForGraduation || effectiveYearLevel >= maxCurriculumYear;

  return {
    hasProspectus,
    isFrozen,
    totalSubjects,
    completedSubjects,
    remainingSubjects,
    totalUnits: Number(totalUnits.toFixed(1)),
    completedUnits: Number(completedUnits.toFixed(1)),
    remainingUnits: Number(remainingUnits.toFixed(1)),
    completionPct,
    maxCurriculumYear,
    isGraduating,
    isReadyForGraduation,
  };
}
