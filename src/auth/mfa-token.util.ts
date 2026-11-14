import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_TOKEN_SECRET = 'viascholar-super-secret-key';

export function generateBase32Secret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(base32: string): Buffer {
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpCode(
  base32Secret: string,
  windowOffset = 0,
  timestampMs = Date.now(),
): string {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(timestampMs / 1000 / 30) + windowOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(
  base32Secret: string,
  inputCode: string,
): boolean {
  const normalized = inputCode.trim();
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }
  const now = Date.now();
  return [-1, 0, 1].some(
    (offset) => generateTotpCode(base32Secret, offset, now) === normalized,
  );
}

function getSecretKey(secret?: string): string {
  return secret || process.env.JWT_SECRET || DEFAULT_TOKEN_SECRET;
}

function signPayload(payload: object, secret?: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecretKey(secret))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySignedPayload<T>(token: string, secret?: string): T | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = createHmac('sha256', getSecretKey(secret))
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export interface MfaChallengeTokenPayload {
  userId: number;
  email: string;
  purpose: 'REGISTER' | 'LOGIN';
  rememberSession?: boolean;
  exp: number;
}

export function signMfaChallengeToken(
  payload: Omit<MfaChallengeTokenPayload, 'exp'>,
  secret?: string,
  ttlMs = 10 * 60 * 1000,
): string {
  return signPayload(
    {
      ...payload,
      exp: Date.now() + ttlMs,
    },
    secret,
  );
}

export function verifyMfaChallengeToken(
  token: string,
  secret?: string,
): MfaChallengeTokenPayload | null {
  const parsed = verifySignedPayload<MfaChallengeTokenPayload>(token, secret);
  if (
    !parsed ||
    typeof parsed.userId !== 'number' ||
    typeof parsed.email !== 'string' ||
    (parsed.purpose !== 'REGISTER' && parsed.purpose !== 'LOGIN') ||
    typeof parsed.exp !== 'number' ||
    parsed.exp <= Date.now()
  ) {
    return null;
  }
  return parsed;
}

interface TrustedDeviceTokenPayload {
  userId: number;
  type: 'TRUSTED_DEVICE';
  exp: number;
}

export function signTrustedDeviceToken(
  userId: number,
  secret?: string,
  ttlMs = 30 * 24 * 60 * 60 * 1000,
): string {
  return signPayload(
    {
      userId,
      type: 'TRUSTED_DEVICE',
      exp: Date.now() + ttlMs,
    },
    secret,
  );
}

export function verifyTrustedDeviceToken(
  token: string | undefined,
  expectedUserId: number,
  secret?: string,
): boolean {
  if (!token) return false;
  const parsed = verifySignedPayload<TrustedDeviceTokenPayload>(token, secret);
  if (
    !parsed ||
    parsed.type !== 'TRUSTED_DEVICE' ||
    parsed.userId !== expectedUserId ||
    typeof parsed.exp !== 'number' ||
    parsed.exp <= Date.now()
  ) {
    return false;
  }
  return true;
}
