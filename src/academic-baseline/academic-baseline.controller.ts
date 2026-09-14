import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
import { AcademicBaselineService } from './academic-baseline.service.js';
import { SelectSchoolDto } from './dto/select-school.dto.js';
import { BatchUpdateSubjectsDto } from './dto/batch-update-subjects.dto.js';
import { FreezeBaselineDto } from './dto/freeze-baseline.dto.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    role: string;
    [key: string]: unknown;
  };
}

@ApiTags('Scholar Academic Baseline Setup (Post-Contract)')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('academic-baseline')
export class AcademicBaselineController {
  constructor(
    private readonly baselineService: AcademicBaselineService,
  ) {}

  private validateUploadedFiles(files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file must be provided.');
    }
    const maxSizeBytes = 10 * 1024 * 1024; // 10MB limit
    const allowedExtensions = /(jpg|jpeg|png|webp|pdf)$/i;

    for (const f of files) {
      if (f.size > maxSizeBytes) {
        throw new BadRequestException(`File "${f.originalname}" exceeds 10MB.`);
      }
      const ext = f.originalname.split('.').pop() || '';
      if (!allowedExtensions.test(f.mimetype) && !allowedExtensions.test(ext)) {
        throw new BadRequestException(
          `File "${f.originalname}" has unsupported format. Allowed: JPG, PNG, WEBP, PDF.`,
        );
      }
    }
  }

  // ==========================================
  // SCHOLAR ONBOARDING ENDPOINTS
  // ==========================================

  @Get('me')
  @Roles(Role.SCHOLAR, Role.APPLICANT, Role.COORDINATOR, Role.GRANTOR, Role.ADMIN)
  @ApiOperation({
    summary: 'Scholar views their complete academic baseline setup state and checklist',
  })
  getMyBaseline(@Request() req: AuthenticatedRequest) {
    return this.baselineService.getScholarBaselineState(req.user.user_id);
  }

  @Post('select-school')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary: 'Scholar selects existing school grading system or proposes new institution',
  })
  selectSchool(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SelectSchoolDto,
  ) {
    return this.baselineService.selectOrProposeSchool(req.user.user_id, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('upload-prospectus')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Scholar uploads curriculum prospectus evaluation sheet for OCR ingestion',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Prospectus PDF or image scans',
        },
      },
    },
  })
  uploadProspectus(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    this.validateUploadedFiles(files);
    return this.baselineService.uploadProspectus(req.user.user_id, files);
  }

  @Put('prospectus/subjects')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary: 'Scholar adjusts or corrects prospectus subjects before submitting for review',
  })
  updateMyProspectusSubjects(
    @Request() req: AuthenticatedRequest,
    @Body() dto: BatchUpdateSubjectsDto,
  ) {
    return this.baselineService.updateProspectusSubjects(req.user.user_id, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('upload-historical-ccg')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Continuing scholar uploads historical CCG/TOR to auto-credit completed courses',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Historical transcript / grade slip PDFs or images',
        },
      },
    },
  })
  uploadHistoricalCcg(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    this.validateUploadedFiles(files);
    return this.baselineService.uploadHistoricalCcg(req.user.user_id, files);
  }

  @Post('submit-for-review')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary: 'Scholar finalizes checklist and submits baseline for coordinator audit',
  })
  submitForReview(@Request() req: AuthenticatedRequest) {
    return this.baselineService.submitForReview(req.user.user_id);
  }

  // ==========================================
  // COORDINATOR AUDIT & FREEZE ENDPOINTS
  // ==========================================

  @Get('coordinator/pending')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Coordinator lists all scholars awaiting baseline review or frozen',
  })
  getPendingBaselines() {
    return this.baselineService.getCoordinatorPendingBaselines();
  }

  @Get('coordinator/active-scholars')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Coordinator lists all active scholars with real-time academic standing & financial summary',
  })
  getActiveScholars() {
    return this.baselineService.getCoordinatorActiveScholars();
  }

  @Get('coordinator/review/:scholarProfileId')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Coordinator gets full side-by-side baseline audit data for a scholar',
  })
  getCoordinatorReview(
    @Param('scholarProfileId', ParseIntPipe) scholarProfileId: number,
  ) {
    return this.baselineService.getCoordinatorBaselineReview(scholarProfileId);
  }

  @Put('coordinator/review/:prospectusId/subjects')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Coordinator edits, adds, or overrides subjects and credit statuses on prospectus',
  })
  coordinatorUpdateSubjects(
    @Request() req: AuthenticatedRequest,
    @Param('prospectusId', ParseIntPipe) prospectusId: number,
    @Body() dto: BatchUpdateSubjectsDto,
  ) {
    return this.baselineService.coordinatorUpdateSubjects(
      req.user.user_id,
      prospectusId,
      dto,
    );
  }

  @Post('coordinator/freeze/:prospectusId')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Coordinator locks and freezes baseline curriculum, preventing further edits',
  })
  freezeBaseline(
    @Request() req: AuthenticatedRequest,
    @Param('prospectusId', ParseIntPipe) prospectusId: number,
    @Body() dto: FreezeBaselineDto,
  ) {
    return this.baselineService.freezeBaseline(
      req.user.user_id,
      prospectusId,
      dto,
    );
  }

  @Post('coordinator/unfreeze/:prospectusId')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Coordinator unlocks/unfreezes baseline curriculum if amendments are needed',
  })
  unfreezeBaseline(
    @Request() req: AuthenticatedRequest,
    @Param('prospectusId', ParseIntPipe) prospectusId: number,
  ) {
    return this.baselineService.unfreezeBaseline(
      req.user.user_id,
      prospectusId,
    );
  }
}
