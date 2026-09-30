import {
  calculateScholarGwa,
  evaluateGwaThreshold,
  evaluateScholarHealth,
} from './scholar-evaluation.util.js';

describe('Scholar Evaluation Utilities', () => {
  describe('evaluateGwaThreshold', () => {
    it('evaluates standard 100% percentage scale correctly', () => {
      expect(evaluateGwaThreshold(92, 90)).toBe(true);
      expect(evaluateGwaThreshold(88, 90)).toBe(false);
    });

    it('evaluates inverted 5.0 scale (USEP / UP) correctly', () => {
      const config = {
        grading_scale: 'NUMERIC_5_POINT',
        highest_grade: 1.0,
        passing_grade: 3.0,
        failing_grade: 5.0,
      };
      // 1.0 is highest (100%), 3.0 is passing (75%), 90% translates to ~1.80
      expect(evaluateGwaThreshold(1.5, 90, config)).toBe(true);
      expect(evaluateGwaThreshold(1.8, 90, config)).toBe(true);
      expect(evaluateGwaThreshold(2.2, 90, config)).toBe(false);
    });

    it('evaluates ascending 4.0 scale (UM) correctly', () => {
      const config = {
        grading_scale: 'NUMERIC_4_POINT',
        highest_grade: 4.0,
        passing_grade: 2.0,
        failing_grade: 1.0,
      };
      // 4.0 is highest (100%), 2.0 is passing (75%), 90% is 3.5
      expect(evaluateGwaThreshold(3.8, 90, config)).toBe(true);
      expect(evaluateGwaThreshold(3.5, 90, config)).toBe(true);
      expect(evaluateGwaThreshold(3.0, 90, config)).toBe(false);
    });
  });

  describe('calculateScholarGwa', () => {
    it('uses latest grade report GPA if available', () => {
      const scholar = {
        grade_reports: [{ gpa: 1.75 }],
      };
      expect(calculateScholarGwa(scholar, 90)).toBe(1.75);
    });

    it('calculates weighted GWA from prospectus subjects when no grade report', () => {
      const scholar = {
        grade_reports: [],
        prospectus: {
          subjects: [
            { grade: '1.5', units: 3 },
            { grade: '2.0', units: 3 },
          ],
        },
      };
      expect(calculateScholarGwa(scholar, 90)).toBe(1.75);
    });
  });

  describe('evaluateScholarHealth', () => {
    it('marks flagged reports as bad', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: { grading_scale: 'PERCENTAGE_100', passing_grade: 75 },
      };
      const report = { status: 'FLAGGED' };
      expect(evaluateScholarHealth(88, scholar, report, 90)).toBe('bad');
    });

    it('marks probation as warn', () => {
      const scholar = {
        academic_baseline_status: 'ON_PROBATION',
        school_grading_system: { grading_scale: 'PERCENTAGE_100', passing_grade: 75 },
      };
      expect(evaluateScholarHealth(92, scholar, null, 90)).toBe('warn');
    });

    it('marks high-performing compliant scholar as good', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: { grading_scale: 'PERCENTAGE_100', passing_grade: 75 },
      };
      expect(evaluateScholarHealth(94, scholar, null, 90)).toBe('good');
    });
  });
});
