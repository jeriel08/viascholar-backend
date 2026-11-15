import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface JwtPayload {
  sub: number;
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'viascholar-super-secret-key',
    });
  }

  async validate(payload: JwtPayload) {
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

    return {
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
  }
}
