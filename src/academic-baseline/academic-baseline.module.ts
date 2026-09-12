import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { AcademicBaselineController } from './academic-baseline.controller.js';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { ProspectusOcrService } from './prospectus-ocr.service.js';

@Module({
  imports: [CloudinaryModule, SettingsModule, DocumentsModule],
  controllers: [AcademicBaselineController],
  providers: [AcademicBaselineService, ProspectusOcrService],
  exports: [AcademicBaselineService, ProspectusOcrService],
})
export class AcademicBaselineModule {}
