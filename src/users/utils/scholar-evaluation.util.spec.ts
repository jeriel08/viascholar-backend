import { describe, expect, it } from 'vitest';

import {
  calculateScholarGwa,
  evaluateGwaThreshold,
  evaluateScholarHealth,
} from './scholar-evaluation.util.js';

const percentageConfig = {
  grading_scale: 'PERCENTAGE_100',
  highest_grade: 100,
  passing_grade: 75,
  failing_grade: 50,
};

const fivePointConfig = {
  grading_scale: 'NUMERIC_5_POINT',
  highest_grade: 1.0,
  passing_grade: 3.0,
  failing_grade: 5.0,
};

const fourPointConfig = {
  grading_scale: 'NUMERIC_4_POINT',
  highest_grade: 4.0,
  passing_grade: 2.0,
  failing_grade: 1.0,
};

describe('Scholar Evaluation Utilities', () => {
  describe('evaluateGwaThreshold', () => {
    it('evaluates standard 100% percentage scale correctly', () => {
      expect(evaluateGwaThreshold(92, 90)).toBe(true);
      expect(evaluateGwaThreshold(88, 90)).toBe(false);
    });

    it('treats an explicit PERCENTAGE_100 configuration as a direct comparison', () => {
      expect(evaluateGwaThreshold(90, 90, percentageConfig)).toBe(true);
      expect(evaluateGwaThreshold(89.99, 90, percentageConfig)).toBe(false);
    });

    it('evaluates inverted 5.0 scale (USEP / UP) correctly', () => {
      // 1.0 is highest (100%), 3.0 is passing (75%), 90% translates to ~1.80
      expect(evaluateGwaThreshold(1.5, 90, fivePointConfig)).toBe(true);
      expect(evaluateGwaThreshold(1.8, 90, fivePointConfig)).toBe(true);
      expect(evaluateGwaThreshold(2.2, 90, fivePointConfig)).toBe(false);
    });

    it('evaluates ascending 4.0 scale (UM) correctly', () => {
      // 4.0 is highest (100%), 2.0 is passing (75%), 90% is 3.5
      expect(evaluateGwaThreshold(3.8, 90, fourPointConfig)).toBe(true);
      expect(evaluateGwaThreshold(3.5, 90, fourPointConfig)).toBe(true);
      expect(evaluateGwaThreshold(3.0, 90, fourPointConfig)).toBe(false);
    });

    it('interpolates ascending scales between 75% and 90%', () => {
      // 80% translates to 2.0 + (5 / 15) * 1.5 = 2.50
      expect(evaluateGwaThreshold(2.5, 80, fourPointConfig)).toBe(true);
      expect(evaluateGwaThreshold(2.49, 80, fourPointConfig)).toBe(false);
      expect(evaluateGwaThreshold(2.0, 75, fourPointConfig)).toBe(true);
    });

    it('interpolates ascending scales above 90%', () => {
      // 95% translates to 3.5 + (5 / 10) * 0.5 = 3.75
      expect(evaluateGwaThreshold(3.75, 95, fourPointConfig)).toBe(true);
      expect(evaluateGwaThreshold(3.74, 95, fourPointConfig)).toBe(false);
      expect(evaluateGwaThreshold(4, 100, fourPointConfig)).toBe(true);
    });

    it('clamps thresholds below 75% to the passing grade', () => {
      expect(evaluateGwaThreshold(2, 60, fourPointConfig)).toBe(true);
      expect(evaluateGwaThreshold(1.99, 60, fourPointConfig)).toBe(false);
    });

    it('clamps thresholds above 100% to the highest grade on inverted scales', () => {
      expect(evaluateGwaThreshold(1, 110, fivePointConfig)).toBe(true);
      expect(evaluateGwaThreshold(1.01, 110, fivePointConfig)).toBe(false);
    });

    it('falls back to 1.0 / 3.0 / 5.0 defaults when the configuration omits grades', () => {
      // Without fields the code defaults to the inverted 5-point interpretation.
      expect(evaluateGwaThreshold(1.8, 90, {})).toBe(true);
      expect(evaluateGwaThreshold(1.81, 90, {})).toBe(false);
    });
  });

  describe('calculateScholarGwa', () => {
    it('uses latest grade report GPA if available', () => {
      const scholar = {
        grade_reports: [{ gpa: 1.75 }],
      };
      expect(calculateScholarGwa(scholar, 90)).toBe(1.75);
    });

    it('coerces a numeric string GPA from the latest report', () => {
      expect(
        calculateScholarGwa({ grade_reports: [{ gpa: '2.25' }] }, 90),
      ).toBe(2.25);
    });

    it('ignores a non-numeric GPA and falls through to the prospectus', () => {
      const scholar = {
        grade_reports: [{ gpa: 'N/A' }, { gpa: 1.1 }],
        prospectus: {
          subjects: [
            { grade: '1.5', units: 3 },
            { grade: '2.0', units: 3 },
          ],
        },
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

    it('defaults missing subject units to 3 and ignores ungraded subjects', () => {
      const scholar = {
        grade_reports: [],
        prospectus: {
          subjects: [
            { grade: '1.5', units: null },
            { grade: '2.0', units: 1 },
            { grade: null, units: 5 },
            { grade: 'INC', units: 3 },
          ],
        },
      };

      // (1.5 * 3 + 2.0 * 1) / 4 = 1.625 -> 1.63
      expect(calculateScholarGwa(scholar, 90)).toBe(1.63);
    });

    it('falls back to the school highest grade when no subject carries a grade', () => {
      const scholar = {
        grade_reports: [],
        prospectus: { subjects: [{ grade: null, units: 3 }] },
        school_grading_system: { highest_grade: 1.25 },
      };

      expect(calculateScholarGwa(scholar, 90)).toBe(1.25);
    });

    it('falls back to the school highest grade when the prospectus is absent', () => {
      expect(
        calculateScholarGwa(
          { school_grading_system: { highest_grade: '95' } },
          90,
        ),
      ).toBe(95);
    });

    it('uses 1.0 for a 5-point scale without an explicit highest grade', () => {
      expect(
        calculateScholarGwa(
          { school_grading_system: { grading_scale: 'NUMERIC_5_POINT' } },
          90,
        ),
      ).toBe(1.0);
    });

    it('uses 4.0 for a 4-point scale without an explicit highest grade', () => {
      expect(
        calculateScholarGwa(
          { school_grading_system: { grading_scale: 'NUMERIC_4_POINT' } },
          90,
        ),
      ).toBe(4.0);
    });

    it('returns the global threshold when no report, prospectus, or scale is available', () => {
      expect(calculateScholarGwa({}, 87.5)).toBe(87.5);
    });
  });

  describe('evaluateScholarHealth', () => {
    it('marks flagged reports as bad', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: {
          grading_scale: 'PERCENTAGE_100',
          passing_grade: 75,
        },
      };
      const report = { status: 'FLAGGED' };
      expect(evaluateScholarHealth(88, scholar, report, 90)).toBe('bad');
    });

    it.each(['ACADEMIC_FAILURE', 'BELOW_PASSING_MARK'])(
      'marks the %s evaluation flag as bad',
      (flag) => {
        const scholar = { academic_baseline_status: 'ACTIVE' };
        const report = { status: 'VERIFIED', evaluation_flag: flag };

        expect(evaluateScholarHealth(95, scholar, report, 90)).toBe('bad');
      },
    );

    it('marks documentation flagged as ineligible as bad', () => {
      const scholar = { academic_baseline_status: 'ACTIVE' };
      const report = { status: 'VERIFIED', is_eligible: false };

      expect(evaluateScholarHealth(95, scholar, report, 90)).toBe('bad');
    });

    it('marks probation as warn', () => {
      const scholar = {
        academic_baseline_status: 'ON_PROBATION',
        school_grading_system: {
          grading_scale: 'PERCENTAGE_100',
          passing_grade: 75,
        },
      };
      expect(evaluateScholarHealth(92, scholar, null, 90)).toBe('warn');
    });

    it('marks an approved appeal as probationary and therefore warn', () => {
      const scholar = { academic_baseline_status: 'ACTIVE' };
      const report = { status: 'VERIFIED', appeal_status: 'APPROVED' };

      expect(evaluateScholarHealth(92, scholar, report, 90)).toBe('warn');
    });

    it('gives a flagged failing report precedence over probation', () => {
      const scholar = { academic_baseline_status: 'ON_PROBATION' };
      const report = { status: 'FLAGGED', appeal_status: 'APPROVED' };

      expect(evaluateScholarHealth(92, scholar, report, 90)).toBe('bad');
    });

    it('marks high-performing compliant scholar as good', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: {
          grading_scale: 'PERCENTAGE_100',
          passing_grade: 75,
        },
      };
      expect(evaluateScholarHealth(94, scholar, null, 90)).toBe('good');
    });

    it('marks a scholar below the passing grade as bad on ascending scales', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: percentageConfig,
      };

      expect(evaluateScholarHealth(70, scholar, null, 90)).toBe('bad');
    });

    it('marks a scholar above the passing grade as bad on inverted scales', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: fivePointConfig,
      };

      expect(evaluateScholarHealth(3.5, scholar, null, 90)).toBe('bad');
    });

    it('warns when the scholar passes but misses the retention threshold', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: percentageConfig,
      };

      expect(evaluateScholarHealth(80, scholar, null, 90)).toBe('warn');
    });

    it('treats a zero GWA as unassessed rather than failing', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: percentageConfig,
      };

      expect(evaluateScholarHealth(0, scholar, null, 90)).toBe('good');
    });

    it('derives 100-point defaults when no school configuration exists', () => {
      const scholar = { academic_baseline_status: 'ACTIVE' };

      expect(evaluateScholarHealth(90, scholar, null, 90)).toBe('good');
      expect(evaluateScholarHealth(80, scholar, null, 90)).toBe('warn');
      expect(evaluateScholarHealth(70, scholar, null, 90)).toBe('bad');
    });

    it('derives 5-point defaults when only the scale name is present', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: { grading_scale: 'NUMERIC_5_POINT' },
      };

      expect(evaluateScholarHealth(1.5, scholar, null, 90)).toBe('good');
      expect(evaluateScholarHealth(4, scholar, null, 90)).toBe('bad');
    });

    it('derives 4-point failure defaults while threshold evaluation uses generic defaults', () => {
      const scholar = {
        academic_baseline_status: 'ACTIVE',
        school_grading_system: { grading_scale: 'NUMERIC_4_POINT' },
      };

      // The health helper defaults failing to 1.0, but evaluateGwaThreshold
      // defaults an unconfigured scale to the 1.0/3.0/5.0 interpretation.
      expect(evaluateScholarHealth(3.5, scholar, null, 90)).toBe('warn');
      expect(evaluateScholarHealth(1.5, scholar, null, 90)).toBe('bad');
    });
  });
});
