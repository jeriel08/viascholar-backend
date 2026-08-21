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
      include: { scholar_profile: true, employee: true },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedException('User account is inactive or missing.');
    }

    const { password_hash, ...result } = user;
    const profile = ((result.scholar_profile ?? result.employee ?? {}) as {
      first_name?: string;
      last_name?: string;
    }) || {};

    return {
      ...result,
      first_name: profile.first_name || '',
      last_name: profile.last_name || '',
    };
  }
}
