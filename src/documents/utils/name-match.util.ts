/**
 * Name matching for official applicant / scholar documents.
 *
 * The database stores only `first_name` and `last_name` (there is no middle
 * name column), while printed documents commonly use different layouts:
 *
 *   - "JERIEL LIAN D. SANAO"
 *   - "SANAO, JERIEL LIAN D."
 *   - "SANAO, JERIEL LIAN DANGO"
 *
 * Matching therefore requires the primary given name (first token of
 * `first_name`) and every token of `last_name` to appear somewhere in the
 * document name. Additional document tokens (middle names, extra given names,
 * suffixes) are ignored, and token order is irrelevant.
 *
 * Tolerance rules:
 *   - A token of up to two characters is treated as an abbreviation/initial
 *     and may match any longer token with that prefix (`D.` vs `DANGO`).
 *   - Compound surnames are also accepted when their compact form appears at
 *     token boundaries in the document (`DE LA CRUZ` vs `DELACRUZ`).
 */

export type NameMatchReason =
  | 'MATCH'
  | 'NAME_NOT_DETECTED'
  | 'REGISTERED_NAME_MISSING'
  | 'MISSING_NAME_TOKENS';

export interface NameProfile {
  first_name?: string | null;
  last_name?: string | null;
}

export interface NameMatchResult {
  matched: boolean;
  reason: NameMatchReason;
  registeredName: string;
  extractedName: string;
  missingTokens: string[];
}

const SUFFIX_TOKENS = new Set([
  'JR',
  'SR',
  'JNR',
  'SNR',
  'II',
  'III',
  'IV',
  'V',
]);

const PREFIX_TOLERANCE_MAX_LENGTH = 2;

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Uppercases and splits a raw name into comparable tokens. Punctuation,
 * diacritics, hyphens, and suffixes are removed so "D." -> "D" and
 * "Sanao, Jeriel" -> ["SANAO", "JERIEL"].
 */
export function tokenizeName(raw?: string | null): string[] {
  if (raw == null) return [];

  return stripDiacritics(String(raw))
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/[-/]/g, ' ')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !SUFFIX_TOKENS.has(token));
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0) return false;

  if (shorter.length <= PREFIX_TOLERANCE_MAX_LENGTH) {
    return longer.startsWith(shorter);
  }

  return false;
}

function hasTokenMatch(documentTokens: string[], target: string): boolean {
  return documentTokens.some((token) => tokensMatch(target, token));
}

/**
 * Accepts compound-surname spacing differences by comparing the compact
 * surname against the compact document name, but only at token boundaries
 * (so "SANAO" does not match a partial token like "SANAOS").
 */
function hasCompactBoundaryMatch(
  documentTokens: string[],
  targetTokens: string[],
): boolean {
  const target = targetTokens.join('');
  if (!target) return false;

  const document = documentTokens.join('');
  const boundaries = new Set<number>();
  let offset = 0;
  for (const token of documentTokens) {
    boundaries.add(offset);
    offset += token.length;
  }
  boundaries.add(offset);

  for (const start of boundaries) {
    const end = start + target.length;
    if (end > document.length) continue;
    if (document.startsWith(target, start) && boundaries.has(end)) {
      return true;
    }
  }

  return false;
}

export function matchApplicantName(
  profile: NameProfile | null | undefined,
  extractedName?: unknown,
): NameMatchResult {
  const registeredFirstTokens = tokenizeName(profile?.first_name);
  const registeredLastTokens = tokenizeName(profile?.last_name);
  const registeredName = [profile?.first_name, profile?.last_name]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .trim();

  const extractedNameRaw =
    typeof extractedName === 'string' ? extractedName.trim() : '';
  const documentTokens = tokenizeName(extractedNameRaw);

  const primaryGivenName = registeredFirstTokens[0];

  if (!primaryGivenName || registeredLastTokens.length === 0) {
    return {
      matched: false,
      reason: 'REGISTERED_NAME_MISSING',
      registeredName,
      extractedName: extractedNameRaw,
      missingTokens: [],
    };
  }

  if (documentTokens.length === 0) {
    return {
      matched: false,
      reason: 'NAME_NOT_DETECTED',
      registeredName,
      extractedName: extractedNameRaw,
      missingTokens: [primaryGivenName, ...registeredLastTokens],
    };
  }

  const givenNameMatched = hasTokenMatch(documentTokens, primaryGivenName);
  const surnameTokensMatched = registeredLastTokens.every((token) =>
    hasTokenMatch(documentTokens, token),
  );
  const surnameMatched =
    surnameTokensMatched ||
    hasCompactBoundaryMatch(documentTokens, registeredLastTokens);

  if (givenNameMatched && surnameMatched) {
    return {
      matched: true,
      reason: 'MATCH',
      registeredName,
      extractedName: extractedNameRaw,
      missingTokens: [],
    };
  }

  const missingTokens = [
    ...(givenNameMatched ? [] : [primaryGivenName]),
    ...(surnameMatched
      ? []
      : registeredLastTokens.filter(
          (token) => !hasTokenMatch(documentTokens, token),
        )),
  ];

  return {
    matched: false,
    reason: 'MISSING_NAME_TOKENS',
    registeredName,
    extractedName: extractedNameRaw,
    missingTokens,
  };
}

function normalizeDocumentType(documentType?: string | null): string {
  return (documentType || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Term-scoped grade documents that must be issued under the applicant's
 * registered name. This covers the application-phase Form 138 / Form 9 and
 * TOR, plus CCG / Certificate of Grades submissions.
 */
export function requiresApplicantNameMatch(
  documentType?: string | null,
): boolean {
  const normalized = normalizeDocumentType(documentType);

  return (
    normalized.includes('CCG') ||
    normalized.includes('CERTIFIEDCOPYOFGRADES') ||
    normalized.includes('CERTIFICATEOFGRADES') ||
    normalized.includes('TRANSCRIPTOFRECORDS') ||
    normalized.includes('TOR') ||
    normalized.includes('FORM138') ||
    normalized.includes('FORM137') ||
    normalized.includes('FORM9') ||
    normalized.includes('SF9') ||
    normalized.includes('REPORTCARD')
  );
}

export function getNameCheckedDocumentLabel(
  documentType?: string | null,
): string {
  const normalized = normalizeDocumentType(documentType);

  if (
    normalized.includes('CCG') ||
    normalized.includes('CERTIFIEDCOPYOFGRADES') ||
    normalized.includes('CERTIFICATEOFGRADES')
  ) {
    return 'Certified Copy of Grades (CCG)';
  }
  if (
    normalized.includes('TRANSCRIPTOFRECORDS') ||
    normalized.includes('TOR')
  ) {
    return 'Transcript of Records (TOR)';
  }
  if (
    normalized.includes('FORM138') ||
    normalized.includes('FORM137') ||
    normalized.includes('FORM9') ||
    normalized.includes('SF9') ||
    normalized.includes('REPORTCARD')
  ) {
    return 'Form 138 / Form 9 (SF9)';
  }

  return 'grade document';
}

export function formatNameMismatchMessage(
  result: NameMatchResult,
  documentLabel?: string,
): string {
  const label = documentLabel || 'grade document';

  if (result.reason === 'NAME_NOT_DETECTED') {
    return `Applicant name not detected: we could not read a student name on the uploaded ${label}. Please upload a clear copy that shows your full name.`;
  }

  if (result.reason === 'REGISTERED_NAME_MISSING') {
    return `We could not verify your identity because your registered first and last name are incomplete. Please update your profile name before uploading your ${label}.`;
  }

  return `Name mismatch: the uploaded ${label} shows "${result.extractedName}", but your registered name is "${result.registeredName}". Please upload a document issued under your own name.`;
}
