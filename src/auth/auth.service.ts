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
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private cloudinaryService: CloudinaryService,
    private auditService: AuditService,
  ) {}

  // Method to handle Avatar upload
  async uploadAvatar(userId: number, file: Express.Multer.File) {
    const result = await this.cloudinaryService.uploadImage(
      file,
      'viascholar/avatars',
    );
    const imageUrl = result.secure_url;

    // Save the URL to user's profile
    const updated = await this.updateProfile(userId, { avatar_url: imageUrl });

    await this.auditService.log(
      userId,
      'AVATAR_UPLOADED',
      `User (ID: ${userId}) uploaded a new avatar`,
    );

    return updated;
  }

  // Method to handle Banner upload
  async uploadBanner(userId: number, file: Express.Multer.File) {
    const result = await this.cloudinaryService.uploadImage(
      file,
      'viascholar/banners',
    );
    const imageUrl = result.secure_url;

    // Save the URL to user's profile
    const updated = await this.updateProfile(userId, { banner_url: imageUrl });

    await this.auditService.log(
      userId,
      'BANNER_UPLOADED',
      `User (ID: ${userId}) uploaded a new banner`,
    );

    return updated;
  }

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
        role: Role.APPLICANT,
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

    await this.auditService.log(
      user.user_id,
      'SCHOLAR_REGISTERED',
      `New scholar registered (ID: ${user.user_id}, Email: ${user.email})`,
    );

    return this.generateToken(
      user.user_id,
      user.email,
      user.role,
      user.scholar_profile,
      null,
    );
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

    await this.auditService.log(
      user.user_id,
      'STAFF_CREATED',
      `New staff account created (ID: ${user.user_id}, Role: ${dto.role}, Email: ${dto.email})`,
    );

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
    );
  }

  private async generateToken(
    userId: number,
    email: string,
    role: string,
    scholar_profile?: unknown,
    employee?: unknown,
  ) {
    const payload = { sub: userId, email, role };
    const token = await this.jwtService.signAsync(payload);
    const profile =
      ((scholar_profile ?? employee ?? {}) as {
        first_name?: string;
        last_name?: string;
      }) || {};

    return {
      access_token: token,
      user: {
        id: userId,
        email,
        role,
        first_name: profile.first_name || '',
        last_name: profile.last_name || '',
        scholar_profile: scholar_profile ?? null,
        employee: employee ?? null,
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

    // 1. If User is an Applicant or Scholar, update scholar_profiles table
    const studentRoles: Role[] = [Role.APPLICANT, Role.SCHOLAR];
    if (studentRoles.includes(user.role) && user.scholar_profile) {
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

    await this.auditService.log(
      userId,
      'PROFILE_UPDATED',
      `User (ID: ${userId}) updated their profile`,
    );

    const { password_hash, ...result } = updatedUser;
    return result;
  }
}
