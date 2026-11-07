import {
  findMatchingTermEnrollment,
  normalizeAcademicYear,
  normalizeSemester,
} from './academic-term.util.js';

describe('academic-term.util', () => {
  describe('normalizeAcademicYear', () => {
    it('normalizes common school year formats', () => {
      expect(normalizeAcademicYear('2023-2024')).toBe('2023-2024');
      expect(normalizeAcademicYear('SY 2023-24')).toBe('2023-2024');
      expect(normalizeAcademicYear('A.Y. 2023 - 2024')).toBe('2023-2024');
      expect(normalizeAcademicYear('1st Semester 2023-2024')).toBe(
        '2023-2024',
      );
    });

    it('returns an empty string when no academic year is present', () => {
      expect(normalizeAcademicYear(undefined)).toBe('');
      expect(normalizeAcademicYear('')).toBe('');
      expect(normalizeAcademicYear('1st Semester')).toBe('');
    });
  });

  describe('normalizeSemester', () => {
    it('normalizes common semester labels', () => {
      expect(normalizeSemester('1st Semester')).toBe('1st Semester');
      expect(normalizeSemester('First Sem')).toBe('1st Semester');
      expect(normalizeSemester('2nd Semester')).toBe('2nd Semester');
      expect(normalizeSemester('Second Semester')).toBe('2nd Semester');
      expect(normalizeSemester('Summer')).toBe('Summer');
      expect(normalizeSemester('Midyear')).toBe('Summer');
    });

    it('returns an empty string when no semester is present', () => {
      expect(normalizeSemester(undefined)).toBe('');
      expect(normalizeSemester('')).toBe('');
    });
  });

  describe('findMatchingTermEnrollment', () => {
    const enrollments = [
      { enrollment_id: 1, academic_year: '2023-24', semester: '2nd Semester' },
      { enrollment_id: 2, academic_year: '2024-2025', semester: '1st Semester' },
    ];

    it('matches formatted variants of the same term', () => {
      expect(
        findMatchingTermEnrollment(
          enrollments,
          'SY 2023-2024',
          'Second Semester',
        )?.enrollment_id,
      ).toBe(1);
    });

    it('does not match a different school year or semester', () => {
      expect(
        findMatchingTermEnrollment(
          enrollments,
          '2024-2025',
          '2nd Semester',
        ),
      ).toBeUndefined();
      expect(
        findMatchingTermEnrollment(
          enrollments,
          '2023-2024',
          '1st Semester',
        ),
      ).toBeUndefined();
    });
  });
});
