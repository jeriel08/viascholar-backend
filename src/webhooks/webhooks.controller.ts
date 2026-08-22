import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

type ParseurFieldSet = { grades?: unknown[] } & Record<string, unknown>;

type ParseurWebhookPayload = {
  custom_fields?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  Result?: Record<string, unknown>;
  result?: Record<string, unknown>;
  viascholar_document_id?: string | number;
  DocumentID?: string | number;
  id?: string | number;
  fields?: ParseurFieldSet;
};

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private prisma: PrismaService) {}

  @Post('parseur')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive OCR parsed payloads directly from Parseur AI',
  })
  async handleParseurWebhook(@Body() payload: ParseurWebhookPayload) {
    // Extract the internal document ID merged into the parsed result at upload time
    const customId =
      payload?.custom_fields?.viascholar_document_id ??
      payload?.metadata?.viascholar_document_id ??
      payload?.Result?.viascholar_document_id ??
      payload?.result?.viascholar_document_id ??
      payload?.viascholar_document_id;

    let documentId: string | number | undefined =
      typeof customId === 'string' || typeof customId === 'number'
        ? customId
        : undefined;

    // Fallback: correlate via Parseur's own DocumentID stored at upload time
    const rawDocId = payload?.DocumentID ?? payload?.id;
    const parseurDocId = rawDocId != null ? String(rawDocId) : null;

    if (!documentId && parseurDocId) {
      const doc = await this.prisma.scholarDocument.findFirst({
        where: { parseur_doc_id: parseurDocId },
        select: { document_id: true },
      });
      documentId = doc?.document_id;
    }

    if (!documentId) {
      this.logger.warn(
        `Ignored Parseur webhook without a resolvable document. Payload keys: ${Object.keys(
          payload ?? {},
        ).join(', ')}`,
      );
      return { status: 'ignored' };
    }

    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: Number(documentId) },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    // Parseur "Document Processed" payloads are flat; some variants nest under fields
    const fields: ParseurFieldSet = payload?.fields ?? { ...payload };
    const hasGrades = Array.isArray(fields.grades) && fields.grades.length > 0;
    const validationStatus = hasGrades ? 'PASSED_PRECHECK' : 'NEEDS_REUPLOAD';

    await this.prisma.scholarDocument.update({
      where: { document_id: Number(documentId) },
      data: {
        status: validationStatus,
        extracted_data: fields as unknown as Prisma.InputJsonValue,
        ...(parseurDocId ? { parseur_doc_id: parseurDocId } : {}),
        rejection_reason: hasGrades
          ? null
          : 'Unreadable document or missing grade records.',
      },
    });

    return { status: 'processed', validationStatus };
  }
}
