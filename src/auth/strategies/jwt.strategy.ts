import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export const JWT_USER_CACHE_TTL_MS = 3 * 60 * 1000;
export const jwtUserCacheKey = (userId: number) => `auth:jwt-user:${userId}`;

export interface JwtPayload {
  sub: number;
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly inFlight = new Map<
    number,
    Promise<Record<string, unknown>>
  >();

  constructor(
    private prisma: PrismaService,
    @Optional() private readonly cacheService?: AppCacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'viascholar-super-secret-key',
    });
  }

  private async loadAndValidateUser(
    payload: JwtPayload,
  ): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: payload.sub },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
          },
        },
        employee: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User account is inactive or missing.');
    }

    if (!user.is_active) {
      if (
        (user.role === 'APPLICANT' || user.role === 'SCHOLAR') &&
        user.scholar_profile?.archived_at
      ) {
        await this.prisma.user.update({
          where: { user_id: user.user_id },
          data: { is_active: true },
        });
        user.is_active = true;
      } else {
        throw new UnauthorizedException('User account is inactive or missing.');
      }
    }

    // Recover any pre-fix shifted scholar profile that was left in onboarding statuses
    if (
      user.scholar_profile &&
      [
        'PENDING_SCHOOL_SELECTION',
        'PENDING_PROSPECTUS',
        'PENDING_HISTORICAL_CCG',
      ].includes(user.scholar_profile.academic_baseline_status) &&
      typeof (this.prisma as any).academicChangeRequest?.findFirst ===
        'function'
    ) {
      const approvedShift = await (
        this.prisma as any
      ).academicChangeRequest.findFirst({
        where: {
          scholar_profile_id: user.scholar_profile.profile_id,
          status: 'APPROVED',
        },
        select: { request_id: true, reviewed_at: true },
        orderBy: { reviewed_at: 'desc' },
      });
      if (approvedShift) {
        await this.prisma.scholarProfile.update({
          where: { profile_id: user.scholar_profile.profile_id },
          data: { academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS' },
        });
        user.scholar_profile.academic_baseline_status =
          'PENDING_SHIFT_PROSPECTUS';
      }
    }

    const { password_hash: unusedPasswordHash, ...result } = user;
    void unusedPasswordHash;
    const profile =
      ((result.scholar_profile ?? result.employee ?? {}) as {
        first_name?: string;
        middle_name?: string | null;
        last_name?: string;
        suffix?: string | null;
        gender?: string | null;
        bio?: string;
        avatar_url?: string;
        banner_url?: string;
      }) || {};

    const validatedUser = {
      ...result,
      first_name: profile.first_name || '',
      middle_name: profile.middle_name ?? null,
      last_name: profile.last_name || '',
      suffix: profile.suffix ?? null,
      gender: profile.gender ?? null,
      bio: profile.bio ?? null,
      avatar_url: profile.avatar_url ?? null,
      banner_url: profile.banner_url ?? null,
    };

    if (this.cacheService) {
      await this.cacheService.set(
        jwtUserCacheKey(payload.sub),
        validatedUser,
        JWT_USER_CACHE_TTL_MS,
      );
    }

    return validatedUser;
  }

  async validate(payload: JwtPayload) {
    if (this.cacheService) {
      const cached = await this.cacheService.get<Record<string, unknown>>(
        jwtUserCacheKey(payload.sub),
      );
      if (cached) {
        return cached;
      }

      const existing = this.inFlight.get(payload.sub);
      if (existing) {
        return existing;
      }

      const promise = this.loadAndValidateUser(payload).finally(() => {
        this.inFlight.delete(payload.sub);
      });
      this.inFlight.set(payload.sub, promise);
      return promise;
    }

    return this.loadAndValidateUser(payload);
  }
}
