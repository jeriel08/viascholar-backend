/**
 * Helpers for matching grade documents (CCG / grade slips) to a scholar's
 * term enrollment.
 *
 * Documents can print academic years in different shapes ("SY 2023-24",
 * "A.Y. 2023 - 2024", "2023-2024") while term enrollments store the same
 * term in another shape. These helpers normalize both sides so term
 * consistency checks compare the actual academic term, not its formatting.
 */

export function normalizeAcademicYear(raw?: string | null): string {
  if (!raw) return '';

  const text = String(raw).trim();
  const match = text.match(/(\d{4})\s*[-–—/]\s*(\d{2,4})/);

  if (match) {
    const start = Number(match[1]);
    const endPart = match[2];
    const end =
      endPart.length === 2
        ? Math.floor(start / 100) * 100 + Number(endPart)
        : Number(endPart);

    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    if (start === end) return `${start}`;

    return `${start}-${end}`;
  }

  const singleYearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (singleYearMatch) {
    return singleYearMatch[1];
  }

  return '';
}

export function academicYearsMatchForTerm(
  ayA?: string | null,
  ayB?: string | null,
  semester?: string | null,
): boolean {
  const normA = normalizeAcademicYear(ayA);
  const normB = normalizeAcademicYear(ayB);

  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const normSem = normalizeSemester(semester);
  if (normSem === 'Summer') {
    const yearsA = normA.split('-');
    const yearsB = normB.split('-');
    if (yearsA.length === 1 && yearsB.includes(yearsA[0])) return true;
    if (yearsB.length === 1 && yearsA.includes(yearsB[0])) return true;
  }

  return false;
}

export function normalizeSemester(raw?: string | null): string {
  if (!raw) return '';

  const text = String(raw).trim().toLowerCase();
  if (!text) return '';

  if (/summer|mid[\s-]?year/.test(text)) return 'Summer';
  if (/third|3rd|sem\s*3|3rd\s*sem/.test(text)) return '3rd Semester';
  if (/second|2nd|sem\s*2|2nd\s*sem/.test(text)) return '2nd Semester';
  if (/first|1st|sem\s*1|1st\s*sem/.test(text)) return '1st Semester';
  if (/annual|whole\s*year/.test(text)) return 'Annual';

  return String(raw).trim();
}

export function findMatchingTermEnrollment<
  T extends { academic_year: string; semester: string },
>(
  enrollments: T[],
  academicYear?: string | null,
  semester?: string | null,
): T | undefined {
  const targetAy = normalizeAcademicYear(academicYear);
  const targetSem = normalizeSemester(semester);

  if (!targetAy || !targetSem) return undefined;

  const exactMatch = enrollments.find(
    (enrollment) =>
      normalizeAcademicYear(enrollment.academic_year) === targetAy &&
      normalizeSemester(enrollment.semester) === targetSem,
  );
  if (exactMatch) return exactMatch;

  return enrollments.find(
    (enrollment) =>
      normalizeSemester(enrollment.semester) === targetSem &&
      academicYearsMatchForTerm(enrollment.academic_year, targetAy, targetSem),
  );
}
