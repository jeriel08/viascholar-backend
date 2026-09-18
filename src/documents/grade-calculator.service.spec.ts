import { GradeCalculatorService } from './grade-calculator.service.js';
import { SettingsService } from '../settings/settings.service.js';

describe('GradeCalculatorService & SettingsService Evaluation', () => {
  let settingsService: SettingsService;
  let gradeCalculatorService: GradeCalculatorService;

  beforeEach(() => {
    // Mock settings service dependencies
    settingsService = new SettingsService({} as any, {} as any, {} as any);
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
        schoolConfig: umConfig as any,
      });

      expect(res.hasFailedGrade).toBe(false);
      expect(res.totalUnits).toBe(6);
      expect(res.computedGwa).toBe(3.25);
    });

    it('should correctly evaluate 90% retention threshold for UM scale (where 2.0 is passing, 4.0 is max)', () => {
      // 90% threshold translates to 3.00 on UM scale
      expect(settingsService.evaluateGwaThreshold(3.5, 90.0, umConfig)).toBe(
        true,
      );
      expect(settingsService.evaluateGwaThreshold(3.0, 90.0, umConfig)).toBe(
        true,
      );
      expect(settingsService.evaluateGwaThreshold(2.9, 90.0, umConfig)).toBe(
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
