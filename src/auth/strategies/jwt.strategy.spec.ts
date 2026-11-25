import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy.js';
import type { JwtPayload } from './jwt.strategy.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Role } from '../../generated/prisma/enums.js';

const createPrismaMock = () => ({
  user: {
    findUnique: vi.fn(),
  },
});

const makeScholarUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 1,
  email: 'scholar@example.com',
  password_hash: 'hashed-password',
  role: Role.SCHOLAR,
  is_active: true,
  scholar_profile: {
    profile_id: 10,
    user_id: 1,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    bio: 'Scholar bio',
    avatar_url: 'https://cdn.test/avatar.png',
    banner_url: 'https://cdn.test/banner.png',
    school_grading_system: {
      school_id: 5,
      school_name: 'University of Mindanao',
    },
  },
  employee: null,
  ...overrides,
});

const makeStaffUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 2,
  email: 'coordinator@example.com',
  password_hash: 'hashed-password',
  role: Role.COORDINATOR,
  is_active: true,
  scholar_profile: null,
  employee: {
    employee_id: 20,
    user_id: 2,
    first_name: 'Maria',
    last_name: 'Santos',
    bio: 'Coordinator bio',
    avatar_url: null,
    banner_url: null,
  },
  ...overrides,
});

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    strategy = new JwtStrategy(prisma as unknown as PrismaService);
  });

  it('throws when the user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      strategy.validate({
        sub: 999,
        email: 'ghost@example.com',
        role: Role.SCHOLAR,
      }),
    ).rejects.toThrow(
      new UnauthorizedException('User account is inactive or missing.'),
    );
  });

  it('throws when the user account is deactivated', async () => {
    prisma.user.findUnique.mockResolvedValue(
      makeScholarUser({ is_active: false }),
    );

    await expect(
      strategy.validate({
        sub: 1,
        email: 'scholar@example.com',
        role: Role.SCHOLAR,
      }),
    ).rejects.toThrow(
      new UnauthorizedException('User account is inactive or missing.'),
    );
  });

  it('loads the scholar profile and returns it without the password hash', async () => {
    const user = makeScholarUser();
    prisma.user.findUnique.mockResolvedValue(user);
    const payload: JwtPayload = {
      sub: 1,
      email: 'scholar@example.com',
      role: Role.SCHOLAR,
    };

    const result = await strategy.validate(payload);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { user_id: 1 },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
          },
        },
        employee: true,
      },
    });
    expect(result).not.toHaveProperty('password_hash');
    expect(result).toMatchObject({
      user_id: 1,
      email: 'scholar@example.com',
      role: Role.SCHOLAR,
      first_name: 'Juan',
      last_name: 'Dela Cruz',
      bio: 'Scholar bio',
      avatar_url: 'https://cdn.test/avatar.png',
      banner_url: 'https://cdn.test/banner.png',
      scholar_profile: user.scholar_profile,
      employee: null,
    });
  });

  it('uses the employee profile for staff accounts', async () => {
    const user = makeStaffUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const result = await strategy.validate({
      sub: 2,
      email: 'coordinator@example.com',
      role: Role.COORDINATOR,
    });

    expect(result).not.toHaveProperty('password_hash');
    expect(result).toMatchObject({
      user_id: 2,
      role: Role.COORDINATOR,
      first_name: 'Maria',
      last_name: 'Santos',
      bio: 'Coordinator bio',
      avatar_url: null,
      banner_url: null,
      scholar_profile: null,
      employee: user.employee,
    });
  });

  it('falls back to empty profile fields when no profile exists', async () => {
    prisma.user.findUnique.mockResolvedValue(
      makeScholarUser({ scholar_profile: null, employee: null }),
    );

    const result = await strategy.validate({
      sub: 1,
      email: 'scholar@example.com',
      role: Role.SCHOLAR,
    });

    expect(result).toMatchObject({
      first_name: '',
      last_name: '',
      bio: null,
      avatar_url: null,
      banner_url: null,
    });
  });

  it('returns cached user without querying Prisma on subsequent validations', async () => {
    const user = makeStaffUser();
    prisma.user.findUnique.mockResolvedValue(user);
    const store = new Map<string, unknown>();
    const cacheMock = {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, val: unknown) => {
        store.set(key, val);
      }),
    };

    const cachedStrategy = new JwtStrategy(
      prisma as unknown as PrismaService,
      cacheMock as unknown as import('../../common/cache/app-cache.service.js').AppCacheService,
    );
    const payload: JwtPayload = {
      sub: 2,
      email: 'coordinator@example.com',
      role: Role.COORDINATOR,
    };

    const first = await cachedStrategy.validate(payload);
    const second = await cachedStrategy.validate(payload);

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(cacheMock.set).toHaveBeenCalledWith(
      'auth:jwt-user:2',
      first,
      3 * 60 * 1000,
    );
    expect(second).toBe(first);
  });

  it('coalesces concurrent cache-miss validations for the same user into one DB query', async () => {
    const user = makeStaffUser();
    prisma.user.findUnique.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(user), 10)),
    );
    const store = new Map<string, unknown>();
    const cacheMock = {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, val: unknown) => {
        store.set(key, val);
      }),
    };

    const cachedStrategy = new JwtStrategy(
      prisma as unknown as PrismaService,
      cacheMock as unknown as import('../../common/cache/app-cache.service.js').AppCacheService,
    );
    const payload: JwtPayload = {
      sub: 2,
      email: 'coordinator@example.com',
      role: Role.COORDINATOR,
    };

    const [a, b] = await Promise.all([
      cachedStrategy.validate(payload),
      cachedStrategy.validate(payload),
    ]);

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});
