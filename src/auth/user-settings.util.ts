export type TwoFactorMethod = 'EMAIL_OTP' | 'SMS_OTP' | 'AUTHENTICATOR_APP';

export const VALID_TWO_FACTOR_METHODS: TwoFactorMethod[] = [
  'EMAIL_OTP',
  'SMS_OTP',
  'AUTHENTICATOR_APP',
];

export interface UserSettings {
  emailNotifs: boolean;
  smsNotifs: boolean;
  forumDigest: boolean;
  twoFactor: boolean;
  twoFactorMethod: TwoFactorMethod | null;
  publicProfile: boolean;
  passwordChangedAt: string | null;
}

export interface PendingTwoFactorSetup {
  method: TwoFactorMethod;
  code?: string;
  secret?: string;
  expiresAt: string;
}

export interface StoredUserSettingsRecord extends UserSettings {
  twoFactorSecret?: string | null;
  pendingTwoFactor?: PendingTwoFactorSetup | null;
}

export const USER_SETTINGS_AUDIT_ACTION = 'USER_SETTINGS_PREFERENCES';

export const DEFAULT_USER_SETTINGS: UserSettings = {
  emailNotifs: true,
  smsNotifs: false,
  forumDigest: true,
  twoFactor: false,
  twoFactorMethod: null,
  publicProfile: true,
  passwordChangedAt: null,
};

function isTwoFactorMethod(value: unknown): value is TwoFactorMethod {
  return (
    typeof value === 'string' &&
    VALID_TWO_FACTOR_METHODS.includes(value as TwoFactorMethod)
  );
}

/**
 * Parses the full stored settings record including internal 2FA setup/secret metadata.
 */
export function parseStoredUserSettings(
  rawDetails?: string | null,
): StoredUserSettingsRecord {
  if (!rawDetails) {
    return { ...DEFAULT_USER_SETTINGS };
  }

  try {
    const parsed = JSON.parse(rawDetails) as Partial<StoredUserSettingsRecord>;
    const pending =
      parsed.pendingTwoFactor &&
      isTwoFactorMethod(parsed.pendingTwoFactor.method) &&
      typeof parsed.pendingTwoFactor.expiresAt === 'string'
        ? {
            method: parsed.pendingTwoFactor.method,
            code:
              typeof parsed.pendingTwoFactor.code === 'string'
                ? parsed.pendingTwoFactor.code
                : undefined,
            secret:
              typeof parsed.pendingTwoFactor.secret === 'string'
                ? parsed.pendingTwoFactor.secret
                : undefined,
            expiresAt: parsed.pendingTwoFactor.expiresAt,
          }
        : null;

    return {
      emailNotifs:
        typeof parsed.emailNotifs === 'boolean'
          ? parsed.emailNotifs
          : DEFAULT_USER_SETTINGS.emailNotifs,
      smsNotifs:
        typeof parsed.smsNotifs === 'boolean'
          ? parsed.smsNotifs
          : DEFAULT_USER_SETTINGS.smsNotifs,
      forumDigest:
        typeof parsed.forumDigest === 'boolean'
          ? parsed.forumDigest
          : DEFAULT_USER_SETTINGS.forumDigest,
      twoFactor:
        typeof parsed.twoFactor === 'boolean'
          ? parsed.twoFactor
          : DEFAULT_USER_SETTINGS.twoFactor,
      twoFactorMethod: isTwoFactorMethod(parsed.twoFactorMethod)
        ? parsed.twoFactorMethod
        : DEFAULT_USER_SETTINGS.twoFactorMethod,
      publicProfile:
        typeof parsed.publicProfile === 'boolean'
          ? parsed.publicProfile
          : DEFAULT_USER_SETTINGS.publicProfile,
      passwordChangedAt:
        typeof parsed.passwordChangedAt === 'string'
          ? parsed.passwordChangedAt
          : DEFAULT_USER_SETTINGS.passwordChangedAt,
      twoFactorSecret:
        typeof parsed.twoFactorSecret === 'string'
          ? parsed.twoFactorSecret
          : null,
      pendingTwoFactor: pending,
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

/**
 * Safely parses public user settings from an AuditLog entry,
 * stripping internal 2FA secrets and pending verification codes.
 */
export function parseUserSettings(rawDetails?: string | null): UserSettings {
  const stored = parseStoredUserSettings(rawDetails);
  return {
    emailNotifs: stored.emailNotifs,
    smsNotifs: stored.smsNotifs,
    forumDigest: stored.forumDigest,
    twoFactor: stored.twoFactor,
    twoFactorMethod: stored.twoFactorMethod,
    publicProfile: stored.publicProfile,
    passwordChangedAt: stored.passwordChangedAt,
  };
}
