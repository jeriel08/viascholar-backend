import { beforeEach, describe, expect, it } from 'vitest';

import type { SchoolGradingSystem } from '../generated/prisma/client.js';
import { GradeCalculatorService } from './services/grade-calculator.service.js';
import { SettingsService } from '../settings/settings.service.js';

describe('GradeCalculatorService & SettingsService Evaluation', () => {
  let settingsService: SettingsService;
  let gradeCalculatorService: GradeCalculatorService;

  beforeEach(() => {
    // Mock settings service dependencies
    settingsService = new SettingsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    gradeCalculatorService = new GradeCalculatorService(settingsService);
  });

  describe('University of Mindanao (UM 4.0 Ascending Scale)', () => {
    const umConfig = {
      school_id: 1,
      school_name: 'University of Mindanao',
      grading_scale: 'NUMERIC_4_POINT',
      highest_grade: 4.0,
      passing_grade: 2.0,
      failing_grade: 1.0,
      special_codes: {
        '9.0': 'DROPPED',
        '7.1': 'LACKING_PAYMENT',
        '7.2': 'LACKING_REQUIREMENTS',
        '1.0': 'FAILED',
        PSD: 'PASSED',
        TWE: 'TOTAL_WITHDRAWAL',
        INC: 'INCOMPLETE',
      },
    };

    it('should evaluate UM passing and honor grades as CLEARED', () => {
      const eval4 = settingsService.evaluateStudentGrade(4.0, umConfig);
      expect(eval4.isPassing).toBe(true);
      expect(eval4.flag).toBe('CLEARED');

      const eval35 = settingsService.evaluateStudentGrade(3.5, umConfig);
      expect(eval35.isPassing).toBe(true);
      expect(eval35.flag).toBe('CLEARED');

      const eval20 = settingsService.evaluateStudentGrade(2.0, umConfig);
      expect(eval20.isPassing).toBe(true);
      expect(eval20.flag).toBe('CLEARED');
    });

    it('should evaluate UM 1.0 or special failure codes as ACADEMIC_FAILURE', () => {
      const eval1 = settingsService.evaluateStudentGrade(1.0, umConfig);
      expect(eval1.isPassing).toBe(false);
      expect(eval1.flag).toBe('ACADEMIC_FAILURE');

      const eval9 = settingsService.evaluateStudentGrade(9.0, umConfig);
      expect(eval9.isPassing).toBe(false);
      expect(eval9.flag).toBe('ACADEMIC_FAILURE');
      expect(eval9.statusLabel).toBe('DROPPED');

      const evalTwe = settingsService.evaluateStudentGrade('TWE', umConfig);
      expect(evalTwe.isPassing).toBe(false);
      expect(evalTwe.flag).toBe('ACADEMIC_FAILURE');
    });

    it('should evaluate UM 7.1 and 7.2 as PENDING_REQUIREMENTS', () => {
      const eval71 = settingsService.evaluateStudentGrade(7.1, umConfig);
      expect(eval71.isPassing).toBe(false);
      expect(eval71.flag).toBe('PENDING_REQUIREMENTS');

      const eval72 = settingsService.evaluateStudentGrade('7.2', umConfig);
      expect(eval72.isPassing).toBe(false);
      expect(eval72.flag).toBe('PENDING_REQUIREMENTS');
    });

    it('should evaluate UM PSD as passed and calculate weighted GWA excluding PSD from unit weights', () => {
      const evalPsd = settingsService.evaluateStudentGrade('PSD', umConfig);
      expect(evalPsd.isPassing).toBe(true);
      expect(evalPsd.flag).toBe('CLEARED');

      const res = gradeCalculatorService.computeGwa({
        gradeItems: [
          { subject_code: 'IT 101', units: 3, grade: 3.5 },
          { subject_code: 'IT 102', units: 3, grade: 3.0 },
          { subject_code: 'NSTP 1', units: 3, grade: 'PSD' },
        ],
        isForm138: false,
        schoolConfig: umConfig as unknown as SchoolGradingSystem,
      });

      expect(res.hasFailedGrade).toBe(false);
      expect(res.totalUnits).toBe(6);
      expect(res.computedGwa).toBe(3.25);
    });

    it('should correctly evaluate 90% retention threshold for UM scale (where 2.0 is passing, 4.0 is max)', () => {
      // 90% threshold translates to 3.50 on UM scale (see evaluateGwaThreshold docs)
      expect(settingsService.evaluateGwaThreshold(3.5, 90.0, umConfig)).toBe(
        true,
      );
      expect(settingsService.evaluateGwaThreshold(3.49, 90.0, umConfig)).toBe(
        false,
      );
      expect(settingsService.evaluateGwaThreshold(3.0, 90.0, umConfig)).toBe(
        false,
      );
      expect(settingsService.evaluateGwaThreshold(2.5, 90.0, umConfig)).toBe(
        false,
      );
      expect(settingsService.evaluateGwaThreshold(2.0, 90.0, umConfig)).toBe(
        false,
      );
    });
  });

  describe('USEP / UP (5.0 Descending Inverted Scale)', () => {
    const usepConfig = {
      school_id: 2,
      school_name: 'University of Southeastern Philippines',
      grading_scale: 'NUMERIC_5_POINT',
      highest_grade: 1.0,
      passing_grade: 3.0,
      failing_grade: 5.0,
      special_codes: {
        '5.0': 'FAILED',
        INC: 'INCOMPLETE',
        DRP: 'DROPPED',
      },
    };

    it('should evaluate USEP 1.0 to 3.0 as passing, and 5.0 / DRP as failed', () => {
      expect(
        settingsService.evaluateStudentGrade(1.25, usepConfig).isPassing,
      ).toBe(true);
      expect(
        settingsService.evaluateStudentGrade(3.0, usepConfig).isPassing,
      ).toBe(true);
      expect(
        settingsService.evaluateStudentGrade(3.5, usepConfig).isPassing,
      ).toBe(false);
      expect(
        settingsService.evaluateStudentGrade(5.0, usepConfig).isPassing,
      ).toBe(false);
      expect(
        settingsService.evaluateStudentGrade('DRP', usepConfig).isPassing,
      ).toBe(false);
    });

    it('should correctly evaluate 90% retention threshold for USEP scale (where 1.0 is max, 3.0 is passing)', () => {
      // 90% threshold translates to 1.80 on 5.0 scale (lower is better)
      expect(settingsService.evaluateGwaThreshold(1.5, 90.0, usepConfig)).toBe(
        true,
      );
      expect(settingsService.evaluateGwaThreshold(1.75, 90.0, usepConfig)).toBe(
        true,
      );
      expect(settingsService.evaluateGwaThreshold(2.0, 90.0, usepConfig)).toBe(
        false,
      );
      expect(settingsService.evaluateGwaThreshold(3.5, 90.0, usepConfig)).toBe(
        false,
      );
    });
  });
});

describe('GradeCalculatorService direct unit tests', () => {
  const makeService = () => {
    const settings = new SettingsService(
      {} as unknown as ConstructorParameters<typeof SettingsService>[0],
      {} as unknown as ConstructorParameters<typeof SettingsService>[1],
      {} as unknown as ConstructorParameters<typeof SettingsService>[2],
      {} as unknown as ConstructorParameters<typeof SettingsService>[3],
    );
    return new GradeCalculatorService(settings);
  };

  describe('isForm138', () => {
    it('matches high school document types and labels', () => {
      const service = makeService();
      expect(service.isForm138('Form 138', '')).toBe(true);
      expect(service.isForm138('Report Card', '')).toBe(true);
      expect(service.isForm138('TOR', 'Senior High')).toBe(true);
      expect(service.isForm138('TOR', '')).toBe(false);
      expect(service.isForm138(undefined, 'High School')).toBe(true);
    });
  });

  describe('computeGwa', () => {
    const um = {
      grading_scale: 'NUMERIC_4_POINT',
      highest_grade: 4.0,
      passing_grade: 2.0,
      failing_grade: 1.0,
      special_codes: { PSD: 'PASSED', TWE: 'TOTAL_WITHDRAWAL' },
    } as unknown as SchoolGradingSystem;

    it('respects the explicit general average without touching weighted math', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [{ subject_code: 'A', units: 3, grade: 1.0 }],
        isForm138: false,
        explicitGeneralAvg: 1.75,
        schoolConfig: um,
      });

      expect(res.computedGwa).toBe(1.75);
      expect(res.hasFailedGrade).toBe(true); // 1.0 fails on UM scale
    });

    it('excludes PSD from unit weighting but counts it as non-failing', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [
          { subject_code: 'A', units: 2, grade: 3.0 },
          { subject_code: 'B', units: 2, grade: 'PSD' },
        ],
        isForm138: false,
        schoolConfig: um,
      });

      expect(res.totalUnits).toBe(2);
      expect(res.computedGwa).toBe(3.0);
      expect(res.hasFailedGrade).toBe(false);
    });

    it('computes the arithmetic mean on the Form 138 path', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [
          { subject_code: 'Math', units: 1, grade: 90 },
          { subject_code: 'English', units: 1, grade: 80 },
          { subject_code: 'Science', units: 1, grade: 70 },
        ],
        isForm138: true,
      });

      expect(res.computedGwa).toBe(80);
      expect(res.hasFailedGrade).toBe(true); // 70 < 75
    });

    it('deduplicates MAPEH sub-components when the parent MAPEH line exists', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [
          { subject_code: 'MAPEH', subject_name: 'MAPEH', units: 4, grade: 92 },
          { subject_code: 'MUSIC', subject_name: 'Music', units: 1, grade: 10 },
          {
            subject_code: 'PE',
            subject_name: 'Physical Education',
            units: 1,
            grade: 10,
          },
        ],
        isForm138: true,
      });

      expect(res.computedGwa).toBe(92); // sub-items dropped
      expect(res.hasFailedGrade).toBe(false);
    });

    it('keeps MAPEH sub-components when the parent MAPEH line is missing', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [
          { subject_code: 'MUSIC', subject_name: 'Music', units: 1, grade: 90 },
          {
            subject_code: 'PE',
            subject_name: 'Physical Education',
            units: 1,
            grade: 70,
          },
        ],
        isForm138: true,
      });

      expect(res.computedGwa).toBe(80);
      expect(res.hasFailedGrade).toBe(true);
    });

    it('returns zero when there are no numeric grades on the college path', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [
          { subject_code: 'A', units: 3, grade: 'PSD' },
          { subject_code: 'B', units: 3, grade: 'TWE' },
        ],
        isForm138: false,
        schoolConfig: um,
      });

      expect(res.computedGwa).toBe(0);
      expect(res.totalUnits).toBe(0);
      expect(res.hasFailedGrade).toBe(true); // TWE fails on UM scale
    });

    it('flags failure for passing-range numeric grades on an unconfigured college path', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [{ subject_code: 'A', units: 3, grade: 4.0 }],
        isForm138: false,
      });

      expect(res.hasFailedGrade).toBe(true); // 3.0 < grade <= 5.0 implies failed
    });

    it('flags failure via evaluateStudentGrade on a Form 138 path with school config', () => {
      const service = makeService();
      const res = service.computeGwa({
        gradeItems: [{ subject_code: 'A', units: 4, grade: 1.0 }],
        isForm138: true,
        schoolConfig: um,
      });

      expect(res.hasFailedGrade).toBe(true);
    });
  });

  describe('normalizeAcademicYear', () => {
    it('extracts the 4-4 year pattern with optional spacing', () => {
      const service = makeService();
      expect(service.normalizeAcademicYear('AY 2026 - 2027')).toBe('2026-2027');
      expect(service.normalizeAcademicYear('2026-2027')).toBe('2026-2027');
    });

    it('falls back to a 15-char slice and finally AY', () => {
      const service = makeService();
      expect(
        service.normalizeAcademicYear('AcademicYearTestFallbackString'),
      ).toBe('AcademicYearTes');
      expect(service.normalizeAcademicYear('')).toBe('AY');
      expect(service.normalizeAcademicYear(undefined)).toBe('AY');
    });
  });

  describe('normalizeSemester', () => {
    it('detects each semester keyword case-insensitively', () => {
      const service = makeService();
      expect(service.normalizeSemester('SECOND SEMESTER')).toBe('2nd Semester');
      expect(service.normalizeSemester('1st Sem')).toBe('1st Semester');
      expect(service.normalizeSemester('3rd Semester')).toBe('3rd Semester');
      expect(service.normalizeSemester('Summer 2026')).toBe('Summer');
      expect(service.normalizeSemester('midyear term')).toBe('Summer');
    });

    it('returns Annual on the Form 138 path with no semester keyword', () => {
      const service = makeService();
      expect(service.normalizeSemester('2026-2027', '2026-2027', true)).toBe(
        'Annual',
      );
    });

    it('passes through free text and defaults to 1st Semester', () => {
      const service = makeService();
      expect(service.normalizeSemester('Fourth Term')).toBe('Fourth Term');
      expect(service.normalizeSemester(undefined)).toBe('1st Semester');
    });
  });

  describe('normalizeGwaToPercentage', () => {
    it('returns 0 for nullish or NaN input', () => {
      const service = makeService();
      expect(service.normalizeGwaToPercentage(NaN)).toBe(0);
    });

    it('clamps Percentage_100 or Form 138 values to the 0-100 range', () => {
      const service = makeService();
      expect(service.normalizeGwaToPercentage(105)).toBe(100);
      expect(service.normalizeGwaToPercentage(-3)).toBe(0);
      expect(service.normalizeGwaToPercentage(87.456, undefined, true)).toBe(
        87.46,
      );
    });

    it('maps the inverted 5-point scale to the 100/75/failing bands', () => {
      const service = makeService();
      const config = {
        highest_grade: 1.0,
        passing_grade: 3.0,
        failing_grade: 5.0,
        grading_scale: 'NUMERIC_5_POINT',
      } as unknown as SchoolGradingSystem;

      expect(service.normalizeGwaToPercentage(1.0, config)).toBe(100);
      // Between highest and passing: 100 - ((gwa-highest)/(passing-highest))*25, floored at 75
      expect(service.normalizeGwaToPercentage(2.0, config)).toBe(87.5);
      // Below passing falls below 75
      const failScore = service.normalizeGwaToPercentage(4.0, config);
      expect(failScore).toBeLessThan(75);
      expect(failScore).toBeGreaterThanOrEqual(0);
    });

    it('maps the direct 4-point scale to the 100/75/failing bands', () => {
      const service = makeService();
      const config = {
        highest_grade: 4.0,
        passing_grade: 2.0,
        failing_grade: 1.0,
        grading_scale: 'NUMERIC_4_POINT',
      } as unknown as SchoolGradingSystem;

      expect(service.normalizeGwaToPercentage(4.0, config)).toBe(100);
      expect(service.normalizeGwaToPercentage(3.0, config)).toBe(87.5);
      expect(service.normalizeGwaToPercentage(1.5, config)).toBeLessThan(75);
    });
  });
});
