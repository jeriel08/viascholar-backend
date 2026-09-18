import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { ScholarEnrollmentService } from './services/scholar-enrollment.service.js';
import { CoordinatorEnrollmentService } from './services/coordinator-enrollment.service.js';
import { SubmitEnrollmentDto } from './dto/submit-enrollment.dto.js';
import { ReviewEnrollmentDto } from './dto/review-enrollment.dto.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    role: string;
    [key: string]: unknown;
  };
}

@ApiTags('Term Enrollment & Statement of Account (Phase 2)')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('term-enrollment')
export class TermEnrollmentController {
  constructor(
    private readonly scholarService: ScholarEnrollmentService,
    private readonly coordinatorService: CoordinatorEnrollmentService,
  ) {}

  private validateUploadedFiles(files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one document file is required.');
    }
    const allowedMimeTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];
    for (const file of files) {
      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new BadRequestException(
          `Invalid file format: ${file.originalname}. Only PDF, PNG, JPG, and WEBP files are supported.`,
        );
      }
      if (file.size > 15 * 1024 * 1024) {
        throw new BadRequestException(
          `File ${file.originalname} exceeds the maximum upload limit of 15 MB.`,
        );
      }
    }
  }

  // ==========================================
  // SCHOLAR ENDPOINTS
  // ==========================================

  @Get('current')
  @Roles(Role.SCHOLAR, Role.ADMIN, Role.COORDINATOR)
  @ApiOperation({ summary: 'Get current term enrollment status and draft for the logged-in scholar' })
  async getCurrentEnrollment(
    @Request() req: AuthenticatedRequest,
    @Query('academic_year') academicYear?: string,
    @Query('semester') semester?: string,
  ) {
    return this.scholarService.getCurrentEnrollment(
      req.user.user_id,
      academicYear,
      semester,
    );
  }

  @Post('upload-cor')
  @Roles(Role.SCHOLAR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload Certificate of Registration (COR) / Form 1 and extract subjects' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
    },
  })
  async uploadCor(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    this.validateUploadedFiles(files);
    return this.scholarService.uploadAndParseCor(req.user.user_id, files[0]);
  }

  @Post('upload-soa')
  @Roles(Role.SCHOLAR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload Statement of Account (SOA) / Student Ledger and extract billing' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
    },
  })
  async uploadSoa(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    this.validateUploadedFiles(files);
    return this.scholarService.uploadAndParseSoa(req.user.user_id, files[0]);
  }

  @Post('upload-consolidated')
  @Roles(Role.SCHOLAR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload single consolidated COR + SOA document (e.g. UM Certificate of Matriculation)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
    },
  })
  async uploadConsolidated(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    this.validateUploadedFiles(files);
    return this.scholarService.uploadAndParseConsolidated(req.user.user_id, files[0]);
  }

  @Post('draft')
  @Roles(Role.SCHOLAR)
  @ApiOperation({ summary: 'Save or update draft term enrollment without submitting' })
  async saveDraft(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SubmitEnrollmentDto,
  ) {
    return this.scholarService.saveDraft(req.user.user_id, dto);
  }

  @Post('pre-audit')
  @Roles(Role.SCHOLAR)
  @ApiOperation({ summary: 'Run live pre-audit checks on enrolled subjects against frozen baseline' })
  async preAudit(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SubmitEnrollmentDto,
  ) {
    return this.scholarService.runPreAudit(req.user.user_id, dto);
  }

  @Post('submit')
  @Roles(Role.SCHOLAR)
  @ApiOperation({ summary: 'Submit start-of-term enrollment credentials for coordinator endorsement' })
  async submitEnrollment(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SubmitEnrollmentDto,
  ) {
    return this.scholarService.submitEnrollment(req.user.user_id, dto);
  }

  @Delete('draft')
  @Roles(Role.SCHOLAR)
  @ApiOperation({ summary: 'Discard and clear active draft term enrollment' })
  async discardDraft(
    @Request() req: AuthenticatedRequest,
    @Query('academic_year') academicYear?: string,
    @Query('semester') semester?: string,
  ) {
    return this.scholarService.discardDraft(
      req.user.user_id,
      academicYear,
      semester,
    );
  }

  // ==========================================
  // COORDINATOR & GRANTOR MONITORING ENDPOINTS
  // ==========================================

  @Get('coordinator/pending')
  @Roles(Role.COORDINATOR, Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Get queue of term enrollments pending review or disbursement' })
  async getPendingEnrollments(
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.coordinatorService.getPendingEnrollments(search, status);
  }

  @Get('coordinator/:id')
  @Roles(Role.COORDINATOR, Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Get full enrollment detail for side-by-side quick audit' })
  async getEnrollmentDetails(@Param('id', ParseIntPipe) id: number) {
    return this.coordinatorService.getEnrollmentDetails(id);
  }

  @Post('coordinator/:id/review')
  @Roles(Role.COORDINATOR, Role.ADMIN)
  @ApiOperation({ summary: 'Approve & endorse to grantor, request changes, or reject enrollment' })
  async reviewEnrollment(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewEnrollmentDto,
  ) {
    return this.coordinatorService.reviewEnrollment(req.user.user_id, id, dto);
  }

  @Post('grantor/:id/authorize-disbursement')
  @Roles(Role.GRANTOR, Role.ADMIN)
  @ApiOperation({ summary: 'Grantor authorizes and releases tuition disbursement for approved enrollment' })
  async authorizeDisbursement(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { remarks?: string; check_number?: string; payment_method?: string },
  ) {
    return this.coordinatorService.grantorAuthorizeDisbursement(req.user.user_id, id, dto);
  }
}
