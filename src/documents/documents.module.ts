import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { PdfMergerService } from './pdf-merger.service.js';
import { DocumentForensicsService } from './document-forensics.service.js';

@Module({
  imports: [CloudinaryModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, PdfMergerService, DocumentForensicsService],
  exports: [DocumentsService, PdfMergerService, DocumentForensicsService],
})
export class DocumentsModule {}
