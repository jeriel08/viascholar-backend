import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterScholarDto } from './dto/register-scholar.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  // 1. Public Scholar Signup
  async registerScholar(dto: RegisterScholarDto) {
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
        role: Role.SCHOLAR,
        scholar_profile: {
          create: {
            first_name: dto.first_name,
            last_name: dto.last_name,
            student_number: dto.student_number,
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

    // Automatically create their initial Application entry with PENDING stage
    await this.prisma.application.create({
      data: {
        scholar_profile_id: user.scholar_profile.profile_id,
        stage: 'Submitted',
        status: 'PENDING',
      },
    });

    return this.generateToken(user.user_id, user.email, user.role);
  }

  // 2. Admin Creates Coordinator or Grantor (Staff)
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

    const { password_hash, ...result } = user;
    return result;
  }

  // 3. System Login
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
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

    return this.generateToken(user.user_id, user.email, user.role);
  }

  private async generateToken(userId: number, email: string, role: string) {
    const payload = { sub: userId, email, role };
    const token = await this.jwtService.signAsync(payload);

    return {
      access_token: token,
      user: {
        id: userId,
        email,
        role,
      },
    };
  }

  // 4. Update User Profile (Scholar or Staff)
  async updateProfile(userId: number, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!user) {
      throw new NotFoundException('User account not found.');
    }

    // 1. If User is a Scholar, update scholar_profiles table
    if (user.role === Role.SCHOLAR && user.scholar_profile) {
      await this.prisma.scholarProfile.update({
        where: { profile_id: user.scholar_profile.profile_id },
        data: {
          first_name: dto.first_name,
          last_name: dto.last_name,
          bio: dto.bio,
          avatar_url: dto.avatar_url,
          banner_url: dto.banner_url,
          student_number: dto.student_number,
          course_of_study: dto.course_of_study,
          school_name: dto.school_name,
          current_year_level: dto.current_year_level,
          scholarship_track: dto.scholarship_track,
        },
      });
    }
    // 2. If User is Staff (Coordinator / Grantor / Admin), update employees table
    else if (user.employee) {
      await this.prisma.employee.update({
        where: { employee_id: user.employee.employee_id },
        data: {
          first_name: dto.first_name,
          last_name: dto.last_name,
          bio: dto.bio,
          avatar_url: dto.avatar_url,
          banner_url: dto.banner_url,
          title: dto.title,
          department: dto.department,
        },
      });
    }

    // Return updated user data
    const updatedUser = await this.prisma.user.findUnique({
      where: { user_id: userId },
      include: { scholar_profile: true, employee: true },
    });

    if (!updatedUser) {
      throw new NotFoundException('Updated user record not found.');
    }

    const { password_hash, ...result } = updatedUser;
    return result;
  }
}
