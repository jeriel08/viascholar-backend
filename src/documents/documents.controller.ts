// src/documents/documents.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  Request,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { DocumentsService } from './documents.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { VerifyDocumentDto } from './dto/verify-document.dto.js';

@ApiTags('Scholar Documents & Grade Verification')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @Roles(Role.SCHOLAR)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Scholar uploads TOR / Form 137 / Grade Slip' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        document_type: { type: 'string', example: 'TOR' },
      },
    },
  })
  uploadDocument(
    @Request() req,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB
          new FileTypeValidator({ fileType: /(jpg|jpeg|png|webp|pdf)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('document_type') documentType: string,
  ) {
    return this.documentsService.uploadDocument(
      req.user.user_id,
      file,
      documentType || 'TOR',
    );
  }

  @Get('pending')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'List pending documents for Coordinator verification',
  })
  getPendingDocuments() {
    return this.documentsService.getPendingDocuments();
  }

  @Patch(':id/verify')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Coordinator confirms extracted grades and triggers eligibility check',
  })
  verifyAndEvaluate(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerifyDocumentDto,
  ) {
    return this.documentsService.verifyAndEvaluate(req.user.user_id, id, dto);
  }
}
