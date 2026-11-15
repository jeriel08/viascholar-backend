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
  emailVerified: boolean;
  phoneVerified: boolean;
  publicProfile: boolean;
  passwordChangedAt: string | null;
}

export interface PendingTwoFactorSetup {
  method: TwoFactorMethod;
  code?: string;
  secret?: string;
  expiresAt: string;
}

export interface PendingContactVerification {
  channel: 'EMAIL' | 'PHONE';
  code: string;
  expiresAt: string;
}

export interface StoredUserSettingsRecord extends UserSettings {
  twoFactorSecret?: string | null;
  pendingTwoFactor?: PendingTwoFactorSetup | null;
  pendingContactVerification?: PendingContactVerification | null;
}

export interface UserSettingsColumnSource {
  is_email_verified?: boolean | null;
  email_verified_at?: Date | string | null;
  two_factor_enabled?: boolean | null;
  two_factor_method?: string | null;
  two_factor_secret?: string | null;
  email_notifs?: boolean | null;
  sms_notifs?: boolean | null;
  forum_digest?: boolean | null;
  public_profile?: boolean | null;
  password_changed_at?: Date | string | null;
  scholar_profile?: {
    is_phone_verified?: boolean | null;
    phone_verified_at?: Date | string | null;
  } | null;
}

export const USER_SETTINGS_AUDIT_ACTION = 'USER_SETTINGS_PREFERENCES';

export const DEFAULT_USER_SETTINGS: UserSettings = {
  emailNotifs: true,
  smsNotifs: false,
  forumDigest: true,
  twoFactor: true,
  twoFactorMethod: 'EMAIL_OTP',
  emailVerified: false,
  phoneVerified: false,
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

    const twoFactor =
      typeof parsed.twoFactor === 'boolean'
        ? parsed.twoFactor
        : DEFAULT_USER_SETTINGS.twoFactor;
    const twoFactorMethod = twoFactor
      ? isTwoFactorMethod(parsed.twoFactorMethod)
        ? parsed.twoFactorMethod
        : DEFAULT_USER_SETTINGS.twoFactorMethod
      : null;

    const pendingContactVerification =
      parsed.pendingContactVerification &&
      (parsed.pendingContactVerification.channel === 'EMAIL' ||
        parsed.pendingContactVerification.channel === 'PHONE') &&
      typeof parsed.pendingContactVerification.code === 'string' &&
      typeof parsed.pendingContactVerification.expiresAt === 'string'
        ? {
            channel: parsed.pendingContactVerification.channel,
            code: parsed.pendingContactVerification.code,
            expiresAt: parsed.pendingContactVerification.expiresAt,
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
      twoFactor,
      twoFactorMethod,
      emailVerified:
        typeof parsed.emailVerified === 'boolean'
          ? parsed.emailVerified
          : DEFAULT_USER_SETTINGS.emailVerified,
      phoneVerified:
        typeof parsed.phoneVerified === 'boolean'
          ? parsed.phoneVerified
          : DEFAULT_USER_SETTINGS.phoneVerified,
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
      pendingContactVerification,
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

/**
 * Extracts public UserSettings from a StoredUserSettingsRecord.
 */
export function stripInternalSettings(
  stored: StoredUserSettingsRecord,
): UserSettings {
  return {
    emailNotifs: stored.emailNotifs,
    smsNotifs: stored.smsNotifs,
    forumDigest: stored.forumDigest,
    twoFactor: stored.twoFactor,
    twoFactorMethod: stored.twoFactorMethod,
    emailVerified: stored.emailVerified,
    phoneVerified: stored.phoneVerified,
    publicProfile: stored.publicProfile,
    passwordChangedAt: stored.passwordChangedAt,
  };
}

/**
 * Combines persistent column values from User / ScholarProfile with any
 * audit-log stored state (including ephemeral pending verification codes).
 */
export function mergeUserColumnsIntoSettings(
  user?: UserSettingsColumnSource | null,
  auditRecord?: StoredUserSettingsRecord | null,
): StoredUserSettingsRecord {
  const base = auditRecord ?? { ...DEFAULT_USER_SETTINGS };

  const twoFactor =
    typeof user?.two_factor_enabled === 'boolean'
      ? user.two_factor_enabled
      : base.twoFactor;

  let twoFactorMethod: TwoFactorMethod | null = base.twoFactorMethod;
  if (!twoFactor) {
    twoFactorMethod = null;
  } else if (user && user.two_factor_method !== undefined) {
    twoFactorMethod = isTwoFactorMethod(user.two_factor_method)
      ? user.two_factor_method
      : DEFAULT_USER_SETTINGS.twoFactorMethod;
  } else if (!twoFactorMethod) {
    twoFactorMethod = DEFAULT_USER_SETTINGS.twoFactorMethod;
  }

  let passwordChangedAt = base.passwordChangedAt;
  if (user && user.password_changed_at !== undefined) {
    passwordChangedAt =
      user.password_changed_at instanceof Date
        ? user.password_changed_at.toISOString()
        : (user.password_changed_at ?? null);
  }

  const twoFactorSecret =
    user && user.two_factor_secret !== undefined
      ? (user.two_factor_secret ?? undefined)
      : base.twoFactorSecret;

  return {
    emailNotifs:
      typeof user?.email_notifs === 'boolean'
        ? user.email_notifs
        : base.emailNotifs,
    smsNotifs:
      typeof user?.sms_notifs === 'boolean' ? user.sms_notifs : base.smsNotifs,
    forumDigest:
      typeof user?.forum_digest === 'boolean'
        ? user.forum_digest
        : base.forumDigest,
    twoFactor,
    twoFactorMethod,
    emailVerified:
      typeof user?.is_email_verified === 'boolean'
        ? user.is_email_verified
        : base.emailVerified,
    phoneVerified:
      typeof user?.scholar_profile?.is_phone_verified === 'boolean'
        ? user.scholar_profile.is_phone_verified
        : base.phoneVerified,
    publicProfile:
      typeof user?.public_profile === 'boolean'
        ? user.public_profile
        : base.publicProfile,
    passwordChangedAt,
    ...(twoFactorSecret !== undefined ? { twoFactorSecret } : {}),
    ...(base.pendingTwoFactor !== undefined
      ? { pendingTwoFactor: base.pendingTwoFactor }
      : {}),
    ...(base.pendingContactVerification !== undefined
      ? { pendingContactVerification: base.pendingContactVerification }
      : {}),
  };
}

/**
 * Safely parses public user settings from an AuditLog entry,
 * stripping internal 2FA secrets and pending verification codes.
 */
export function parseUserSettings(rawDetails?: string | null): UserSettings {
  return stripInternalSettings(parseStoredUserSettings(rawDetails));
}
