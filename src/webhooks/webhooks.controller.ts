import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private prisma: PrismaService) {}

  @Post('parseur')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive OCR parsed payloads directly from Parseur AI',
  })
  async handleParseurWebhook(@Body() payload: any) {
    // Extract the internal document ID merged into the parsed result at upload time
    const documentId =
      payload?.custom_fields?.viascholar_document_id ??
      payload?.metadata?.viascholar_document_id ??
      payload?.Result?.viascholar_document_id ??
      payload?.result?.viascholar_document_id ??
      payload?.viascholar_document_id;

    if (!documentId) {
      console.warn(
        'Received Parseur webhook without valid viascholar_document_id',
      );
      return { status: 'ignored' };
    }

    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: Number(documentId) },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    // Determine validation status based on Parseur confidence / missing fields
    const hasGrades =
      Array.isArray(payload.fields?.grades) && payload.fields.grades.length > 0;
    const validationStatus = hasGrades ? 'PASSED_PRECHECK' : 'NEEDS_REUPLOAD';

    await this.prisma.scholarDocument.update({
      where: { document_id: Number(documentId) },
      data: {
        status: validationStatus,
        extracted_data: payload.fields || payload,
        parseur_doc_id: payload.id ? String(payload.id) : null,
        rejection_reason: hasGrades
          ? null
          : 'Unreadable document or missing grade records.',
      },
    });

    return { status: 'processed', validationStatus };
  }
}
