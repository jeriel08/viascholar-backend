import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Request,
  Patch,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { ProfileService } from './profile.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterScholarDto } from './dto/register-scholar.dto.js';
import { Role } from '../generated/prisma/enums.js';
import { Roles } from './decorators/roles.decorator.js';
import { RolesGuard } from './decorators/roles.guard.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { FileInterceptor } from '@nestjs/platform-express';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    [key: string]: unknown;
  };
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly profileService: ProfileService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiOperation({ summary: 'Public registration for prospective scholars' })
  @ApiResponse({
    status: 201,
    description: 'Scholar registered successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request. Invalid input data.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized. Missing or invalid JWT token.',
  })
  registerScholar(@Body() dto: RegisterScholarDto) {
    return this.authService.registerScholar(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Login for all user roles (Admin, Employee, Scholar)',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request. Invalid input data.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized. Missing or invalid JWT token.',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('create-staff')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Admin-only endpoint to create Coordinator or Grantor accounts',
  })
  @ApiResponse({
    status: 201,
    description: 'Staff member created successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request. Invalid input data.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized. Missing or invalid JWT token.',
  })
  createStaff(@Body() dto: CreateStaffDto) {
    return this.authService.createStaff(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  @ApiResponse({
    status: 201,
    description: 'Staff member created successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request. Invalid input data.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized. Missing or invalid JWT token.',
  })
  getProfile(@Request() req: AuthenticatedRequest) {
    return req.user;
  }

  @Post('refresh-token')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({
    summary: 'Re-issue a fresh JWT token with the latest user role and profile',
  })
  refreshToken(@Request() req: AuthenticatedRequest) {
    return this.authService.refreshToken(req.user.user_id);
  }


  @Patch('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({
    summary: 'Update profile information for the authenticated user',
  })
  @ApiResponse({
    status: 201,
    description: 'User profile updated successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request. Invalid input data.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized. Missing or invalid JWT token.',
  })
  updateProfile(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.updateProfile(req.user.user_id, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('me/avatar')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload avatar image to Cloudinary' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  async uploadAvatar(
    @Request() req: AuthenticatedRequest,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5MB max size limit[cite: 1]
          new FileTypeValidator({ fileType: /(jpg|jpeg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.profileService.uploadAvatar(req.user.user_id, file);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('me/banner')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload banner image to Cloudinary' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  async uploadBanner(
    @Request() req: AuthenticatedRequest,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /(jpg|jpeg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.profileService.uploadBanner(req.user.user_id, file);
  }
}
