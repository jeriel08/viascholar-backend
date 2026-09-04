import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller.js';
import { ContractsService } from './contracts.service.js';
import { PdfStamperService } from './pdf-stamper.service.js';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';

@Module({
  imports: [CloudinaryModule],
  controllers: [ContractsController],
  providers: [ContractsService, PdfStamperService],
  exports: [ContractsService],
})
export class ContractsModule {}
