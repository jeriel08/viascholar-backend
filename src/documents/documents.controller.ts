// src/documents/documents.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
  Request,
  UploadedFiles,
  UseInterceptors,
  ParseIntPipe,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { DocumentsStorageService } from './documents-storage.service.js';
import { DocumentOcrService } from './document-ocr.service.js';
import { DocumentEvaluationService } from './document-evaluation.service.js';
import { GradeReportsService } from './grade-reports.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { VerifyDocumentDto } from './dto/verify-document.dto.js';
import { ConfirmDocumentDto } from './dto/confirm-document.dto.js';
import { RequestChangesDto } from './dto/request-changes.dto.js';
import { QueryGradeReportsDto } from './dto/query-grade-reports.dto.js';
import { UpdateGradeReportStatusDto } from './dto/update-grade-report-status.dto.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    role: string;
    [key: string]: unknown;
  };
}

@ApiTags('Scholar Documents & Grade Verification')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly storageService: DocumentsStorageService,
    private readonly ocrService: DocumentOcrService,
    private readonly evaluationService: DocumentEvaluationService,
    private readonly gradeReportsService: GradeReportsService,
  ) {}

  private validateUploadedFiles(files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file must be provided.');
    }
    const maxSizeBytes = 10 * 1024 * 1024; // 10MB per file
    const allowedExtensions = /(jpg|jpeg|png|webp|pdf)$/i;

    for (const f of files) {
      if (f.size > maxSizeBytes) {
        throw new BadRequestException(
          `File "${f.originalname}" exceeds the 10MB size limit.`,
        );
      }
      const ext = f.originalname.split('.').pop() || '';
      const isFormatAllowed =
        allowedExtensions.test(f.mimetype) || allowedExtensions.test(ext);
      if (!isFormatAllowed) {
        throw new BadRequestException(
          `File "${f.originalname}" has an unsupported format. Allowed formats: JPG, PNG, WEBP, PDF.`,
        );
      }
    }
  }

  @Get('allowed-types')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary:
      'Get allowed document types based on scholar current year level',
  })
  getAllowedDocumentTypes(@Request() req: AuthenticatedRequest) {
    return this.storageService.getAllowedDocumentTypes(req.user.user_id);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('upload')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Scholar uploads TOR / Form 137 / Form 138 (Supports single or multi-page / front & back images or PDFs)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'One or multiple files (Front & Back images / PDFs)',
        },
        file: {
          type: 'string',
          format: 'binary',
          description: 'Single file (for backward compatibility)',
        },
        document_type: { type: 'string', example: 'Form 138' },
      },
    },
  })
  uploadDocument(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('document_type') documentType: string,
  ) {
    this.validateUploadedFiles(files);
    return this.storageService.uploadDocument(
      req.user.user_id,
      files,
      documentType || 'TOR',
    );
  }

  @Put(':id/replace')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Scholar replaces / re-uploads an unverified document (e.g. adding missing back page or clearer scan)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'New file(s) to replace the existing document with',
        },
        file: {
          type: 'string',
          format: 'binary',
          description: 'Single replacement file',
        },
      },
    },
  })
  replaceDocument(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    this.validateUploadedFiles(files);
    return this.storageService.replaceDocument(req.user.user_id, id, files);
  }

  @Delete(':id')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary: 'Scholar deletes / discards an unverified draft document',
  })
  deleteDocument(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.storageService.deleteDocument(req.user.user_id, id);
  }

  @Get('me')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary: 'List own documents with OCR data and coordinator remarks',
  })
  getMyDocuments(@Request() req: AuthenticatedRequest) {
    return this.storageService.getMyDocuments(req.user.user_id);
  }

  @Get('grade-reports/me')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary:
      'Scholar views all their semestral grade reports (Grade Monitoring)',
  })
  getMyGradeReports(@Request() req: AuthenticatedRequest) {
    return this.gradeReportsService.getMyGradeReports(req.user.user_id);
  }

  @Get('grade-reports')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Staff views all semestral grade reports with filters (Grade Monitoring)',
  })
  getAllGradeReports(@Query() query: QueryGradeReportsDto) {
    return this.gradeReportsService.getAllGradeReports(query);
  }

  @Patch('grade-reports/:id/status')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Staff overrides or updates the review status of a grade report',
  })
  updateGradeReportStatus(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGradeReportStatusDto,
  ) {
    return this.gradeReportsService.updateGradeReportStatus(
      req.user.user_id,
      id,
      dto,
    );
  }

  @Get(':id/extracted-data')
  @Roles(
    Role.APPLICANT,
    Role.SCHOLAR,
    Role.COORDINATOR,
    Role.GRANTOR,
    Role.ADMIN,
  )
  @ApiOperation({
    summary: 'Retrieve the Parseur OCR-extracted data of a specific document',
  })
  getExtractedData(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.ocrService.getExtractedData(
      req.user.user_id,
      id,
      req.user.role,
    );
  }

  @Patch(':id/confirm')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary:
      'Confirm or correct the OCR-extracted fields and submit for review',
  })
  confirmDocument(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmDocumentDto,
  ) {
    return this.evaluationService.confirmDocument(req.user.user_id, id, dto);
  }

  @Get('pending')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'List pending documents for Coordinator verification',
  })
  getPendingDocuments() {
    return this.storageService.getPendingDocuments();
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'View full detail of a document submission' })
  getDocumentDetail(@Param('id', ParseIntPipe) id: number) {
    return this.storageService.getDocumentDetail(id);
  }

  @Post(':id/sync-parseur')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR, Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary:
      'Re-fetch OCR results from Parseur and backfill the extracted data',
  })
  syncFromParseur(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.ocrService.syncFromParseur(req.user.user_id, id);
  }

  @Patch(':id/request-changes')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Flag a document as unclear/inconsistent and request re-upload',
  })
  requestChanges(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RequestChangesDto,
  ) {
    return this.evaluationService.requestChanges(
      req.user.user_id,
      id,
      dto.reason,
    );
  }

  @Patch(':id/verify')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Coordinator confirms extracted grades and triggers eligibility check',
  })
  verifyAndEvaluate(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerifyDocumentDto,
  ) {
    return this.evaluationService.verifyAndEvaluate(req.user.user_id, id, dto);
  }
}
