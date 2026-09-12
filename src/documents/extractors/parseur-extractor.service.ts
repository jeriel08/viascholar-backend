import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ExtractedResult,
  IDocumentExtractor,
  InputDocumentFile,
} from './document-extractor.interface.js';

@Injectable()
export class ParseurExtractorService implements IDocumentExtractor {
  private readonly logger = new Logger(ParseurExtractorService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Uploads document buffer to Parseur API mailbox
   */
  async uploadToParseur(
    documentId: number,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<{ parseurDocId?: string; data?: unknown }> {
    const apiKey = this.configService.get<string>('PARSEUR_API_KEY');
    const mailboxId = this.configService.get<string>('PARSEUR_MAILBOX_ID');

    if (!apiKey || !mailboxId) {
      this.logger.warn(
        'Parseur credentials missing in .env. Skipping Parseur upload.',
      );
      return {};
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      fileName,
    );
    form.append('viascholar_document_id', String(documentId));

    const response = await fetch(
      `https://api.parseur.com/parser/${mailboxId}/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
        },
        body: form,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Parseur API responded with status ${response.status}: ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      attachments?: { DocumentID?: string | number }[];
    };

    const parseurDocId =
      data.attachments?.[0]?.DocumentID != null
        ? String(data.attachments[0].DocumentID)
        : undefined;

    return { parseurDocId, data };
  }

  /**
   * Directly extracts data by triggering Parseur upload (Parseur works via webhooks/polling)
   */
  async extractData(
    input: InputDocumentFile | InputDocumentFile[],
    documentType: string,
  ): Promise<ExtractedResult> {
    const files = Array.isArray(input) ? input : [input];
    const firstFile = files[0];
    this.logger.log(
      `Parseur extraction initiated for '${firstFile?.fileName || 'document'}' (${documentType}). Parseur operates via asynchronous webhooks.`,
    );
    return {};
  }
}
