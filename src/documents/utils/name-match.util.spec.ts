import { describe, expect, it } from 'vitest';

import {
  formatNameMismatchMessage,
  getNameCheckedDocumentLabel,
  matchApplicantName,
  requiresApplicantNameMatch,
  tokenizeName,
} from './name-match.util.js';

describe('name-match.util', () => {
  const profile = {
    first_name: 'Jeriel Lian D.',
    last_name: 'Sanao',
  };

  describe('matchApplicantName', () => {
    it('matches common printed name formats for the same applicant', () => {
      expect(matchApplicantName(profile, 'JERIEL LIAN D. SANAO')).toMatchObject(
        {
          matched: true,
          reason: 'MATCH',
        },
      );
      expect(
        matchApplicantName(profile, 'SANAO, JERIEL LIAN D.'),
      ).toMatchObject({
        matched: true,
        reason: 'MATCH',
      });
      expect(
        matchApplicantName(profile, 'SANAO, JERIEL LIAN DANGO'),
      ).toMatchObject({
        matched: true,
        reason: 'MATCH',
      });
    });

    it('ignores middle names and extra given names', () => {
      expect(matchApplicantName(profile, 'JERIEL SANAO')).toMatchObject({
        matched: true,
      });
      expect(
        matchApplicantName(profile, 'SANAO, JERIEL LIAN DANGO S.'),
      ).toMatchObject({
        matched: true,
      });
    });

    it('matches initials and short abbreviations against full tokens', () => {
      expect(matchApplicantName(profile, 'SANAO, J.')).toMatchObject({
        matched: true,
      });
      expect(
        matchApplicantName(
          { first_name: 'Ma. Cristina', last_name: 'Sanao' },
          'MARIA CRISTINA SANAO',
        ),
      ).toMatchObject({
        matched: true,
      });
    });

    it('matches compound surnames with different spacing', () => {
      const cruz = { first_name: 'Juan', last_name: 'Dela Cruz' };

      expect(matchApplicantName(cruz, 'DELA CRUZ, JUAN')).toMatchObject({
        matched: true,
      });
      expect(matchApplicantName(cruz, 'DELACRUZ, JUAN')).toMatchObject({
        matched: true,
      });
      expect(matchApplicantName(cruz, 'DE LA CRUZ, JUAN')).toMatchObject({
        matched: true,
      });
      expect(
        matchApplicantName(
          { first_name: 'Juan', last_name: 'De los Reyes' },
          'DELOS REYES, JUAN',
        ),
      ).toMatchObject({
        matched: true,
      });
    });

    it('normalizes diacritics and suffixes', () => {
      expect(
        matchApplicantName(
          { first_name: 'José', last_name: 'Muñoz Jr.' },
          'MUNOZ, JOSE JR.',
        ),
      ).toMatchObject({
        matched: true,
      });
    });

    it('rejects a different given name or surname', () => {
      expect(matchApplicantName(profile, 'SANAO, MARIA')).toMatchObject({
        matched: false,
        reason: 'MISSING_NAME_TOKENS',
      });
      expect(matchApplicantName(profile, 'DELA CRUZ, JERIEL')).toMatchObject({
        matched: false,
        reason: 'MISSING_NAME_TOKENS',
      });
      expect(matchApplicantName(profile, 'SANAO, LIAN')).toMatchObject({
        matched: false,
        reason: 'MISSING_NAME_TOKENS',
      });
    });

    it('does not accept a partial token as a surname match', () => {
      expect(matchApplicantName(profile, 'SANAOS, JERIEL')).toMatchObject({
        matched: false,
      });
    });

    it('fails closed when the document name is missing', () => {
      expect(matchApplicantName(profile, undefined)).toMatchObject({
        matched: false,
        reason: 'NAME_NOT_DETECTED',
      });
      expect(matchApplicantName(profile, '   ')).toMatchObject({
        matched: false,
        reason: 'NAME_NOT_DETECTED',
      });
    });

    it('fails closed when the registered name is incomplete', () => {
      expect(
        matchApplicantName(
          { first_name: '', last_name: 'Sanao' },
          'SANAO, JERIEL',
        ),
      ).toMatchObject({
        matched: false,
        reason: 'REGISTERED_NAME_MISSING',
      });
    });
  });

  describe('tokenizeName', () => {
    it('strips punctuation, diacritics, and suffixes', () => {
      expect(tokenizeName('SANAO, JERIEL LIAN D. JR.')).toEqual([
        'SANAO',
        'JERIEL',
        'LIAN',
        'D',
      ]);
    });
  });

  describe('document type coverage', () => {
    it('requires a name match for TOR, Form 138/9, and CCG variants', () => {
      expect(requiresApplicantNameMatch('TOR')).toBe(true);
      expect(requiresApplicantNameMatch('Transcript of Records (TOR)')).toBe(
        true,
      );
      expect(requiresApplicantNameMatch('Form 138')).toBe(true);
      expect(requiresApplicantNameMatch('Form 9')).toBe(true);
      expect(requiresApplicantNameMatch('Form 138 / Form 9')).toBe(true);
      expect(requiresApplicantNameMatch('CCG')).toBe(true);
      expect(requiresApplicantNameMatch('Certified Copy of Grades (CCG)')).toBe(
        true,
      );
    });

    it('does not require a name match for unrelated documents', () => {
      expect(requiresApplicantNameMatch('Certificate of Registration')).toBe(
        false,
      );
      expect(requiresApplicantNameMatch('Statement of Account')).toBe(false);
      expect(requiresApplicantNameMatch('Other Document')).toBe(false);
    });

    it('labels name-checked documents', () => {
      expect(getNameCheckedDocumentLabel('Form 138 / Form 9')).toBe(
        'Form 138 / Form 9 (SF9)',
      );
      expect(getNameCheckedDocumentLabel('TOR')).toBe(
        'Transcript of Records (TOR)',
      );
      expect(getNameCheckedDocumentLabel('CCG')).toBe(
        'Certified Copy of Grades (CCG)',
      );
    });

    it('formats a user-facing mismatch message containing both names', () => {
      const result = matchApplicantName(profile, 'DELA CRUZ, JUAN');
      const message = formatNameMismatchMessage(
        result,
        getNameCheckedDocumentLabel('TOR'),
      );

      expect(message).toContain('DELA CRUZ, JUAN');
      expect(message).toContain('Jeriel Lian D. Sanao');
      expect(message).toContain('Transcript of Records (TOR)');
    });
  });
});
