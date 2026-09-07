import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';

@Injectable()
export class ProfileService {
  constructor(
    private prisma: PrismaService,
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

  // Update User Profile (Scholar or Staff)
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
      if (dto.phone_number) {
        const duplicatePhone = await this.prisma.scholarProfile.findFirst({
          where: {
            phone_number: dto.phone_number,
            profile_id: { not: user.scholar_profile.profile_id },
          },
        });
        if (duplicatePhone) {
          throw new ConflictException(
            'Phone number is already in use by another profile.',
          );
        }
      }

      if (dto.student_number) {
        const duplicateStudentNum = await this.prisma.scholarProfile.findFirst({
          where: {
            student_number: dto.student_number,
            profile_id: { not: user.scholar_profile.profile_id },
          },
        });
        if (duplicateStudentNum) {
          throw new ConflictException(
            'Student number is already in use by another scholar.',
          );
        }
      }

      await this.prisma.scholarProfile.update({
        where: { profile_id: user.scholar_profile.profile_id },
        data: {
          first_name: dto.first_name,
          last_name: dto.last_name,
          phone_number: dto.phone_number,
          student_address: dto.student_address,
          school_address: dto.school_address,
          student_number: dto.student_number,
          bio: dto.bio,
          avatar_url: dto.avatar_url,
          banner_url: dto.banner_url,
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

    const sanitizedUser: Partial<typeof updatedUser> = { ...updatedUser };
    delete sanitizedUser.password_hash;
    return sanitizedUser;
  }
}
