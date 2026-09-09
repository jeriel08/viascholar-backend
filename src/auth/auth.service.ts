import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterScholarDto } from './dto/register-scholar.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private auditService: AuditService,
    private eventsGateway: EventsGateway,
  ) {}

  // 1. Public Scholar Signup
  async registerScholar(dto: RegisterScholarDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email address is already in use.');
    }

    const existingPhone = await this.prisma.scholarProfile.findFirst({
      where: { phone_number: dto.phone_number },
    });

    if (existingPhone) {
      throw new ConflictException('Phone number is already registered.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        role: Role.APPLICANT,
        scholar_profile: {
          create: {
            first_name: dto.first_name,
            last_name: dto.last_name,
            phone_number: dto.phone_number,
          },
        },
      },
      include: { scholar_profile: true },
    });

    if (!user.scholar_profile) {
      throw new InternalServerErrorException(
        'Scholar profile was not created successfully.',
      );
    }

    await this.auditService.log(
      user.user_id,
      'SCHOLAR_REGISTERED',
      `Scholar registered (User ID: ${user.user_id}, Email: ${user.email})`,
    );

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      undefined,
      user.created_at,
    );
  }

  // 2. Admin/Grantor creates Staff Accounts
  async createStaff(dto: CreateStaffDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email address is already in use.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        role: dto.role,
        employee: {
          create: {
            first_name: dto.first_name,
            last_name: dto.last_name,
            title: dto.title,
            department: dto.department,
          },
        },
      },
      include: { employee: true },
    });

    if (!user.employee) {
      throw new InternalServerErrorException(
        'Staff profile was not created successfully.',
      );
    }

    await this.auditService.log(
      user.user_id,
      'STAFF_CREATED',
      `Staff account created (User ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
    );

    this.eventsGateway.emitToAdmin('staff:created', {
      id: user.user_id,
      user_id: user.user_id,
      email: user.email,
      role: user.role,
      employee: user.employee,
    });

    return {
      message: 'Staff account successfully created.',
      user: {
        id: user.user_id,
        email: user.email,
        role: user.role,
        employee: user.employee,
      },
    };
  }

  // 3. Global Login (Scholar and Staff)
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (!user.is_active) {
      throw new UnauthorizedException(
        'Account is disabled. Please contact the administrator.',
      );
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.password_hash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    // Update last login timestamp
    await this.prisma.user.update({
      where: { user_id: user.user_id },
      data: { last_login_at: new Date() },
    });

    await this.auditService.log(
      user.user_id,
      'USER_LOGIN',
      `User logged in (ID: ${user.user_id}, Email: ${user.email}, Role: ${user.role})`,
    );

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      user.employee,
      user.created_at,
    );
  }

  // 4. Refresh / Re-issue token with fresh role and profile
  async refreshToken(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found.');
    }

    if (!user.is_active) {
      throw new UnauthorizedException(
        'Account is disabled. Please contact the administrator.',
      );
    }

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      user.employee,
      user.created_at,
    );
  }

  private async generateToken(
    userId: number,
    email: string,
    role: string,
    scholar_profile?: unknown,
    employee?: unknown,
    created_at?: Date,
  ) {
    const payload = { sub: userId, email, role };
    const token = await this.jwtService.signAsync(payload);
    const profile =
      ((scholar_profile ?? employee ?? {}) as {
        first_name?: string;
        last_name?: string;
        bio?: string;
        avatar_url?: string;
        banner_url?: string;
      }) || {};

    return {
      access_token: token,
      user: {
        id: userId,
        user_id: userId,
        email,
        role,
        first_name: profile.first_name || '',
        last_name: profile.last_name || '',
        bio: profile.bio ?? null,
        avatar_url: profile.avatar_url ?? null,
        banner_url: profile.banner_url ?? null,
        created_at: created_at ?? null,
        scholar_profile: scholar_profile ?? null,
        employee: employee ?? null,
      },
    };
  }
}
