export interface UserSettings {
  emailNotifs: boolean;
  smsNotifs: boolean;
  forumDigest: boolean;
  twoFactor: boolean;
  publicProfile: boolean;
}

export const USER_SETTINGS_AUDIT_ACTION = 'USER_SETTINGS_PREFERENCES';

export const DEFAULT_USER_SETTINGS: UserSettings = {
  emailNotifs: true,
  smsNotifs: false,
  forumDigest: true,
  twoFactor: false,
  publicProfile: true,
};

/**
 * Safely parses serialized user settings from an AuditLog entry,
 * falling back to system defaults for any missing or invalid fields.
 */
export function parseUserSettings(rawDetails?: string | null): UserSettings {
  if (!rawDetails) {
    return { ...DEFAULT_USER_SETTINGS };
  }

  try {
    const parsed = JSON.parse(rawDetails) as Partial<UserSettings>;
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
      publicProfile:
        typeof parsed.publicProfile === 'boolean'
          ? parsed.publicProfile
          : DEFAULT_USER_SETTINGS.publicProfile,
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}
