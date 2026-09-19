import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller.js';
import { ContractsService } from './contracts.service.js';
import { ContractSigningService } from './services/contract-signing.service.js';
import { PdfStamperService } from './services/pdf-stamper.service.js';
import { PdfCertificateService } from './services/pdf-certificate.service.js';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';

@Module({
  imports: [CloudinaryModule],
  controllers: [ContractsController],
  providers: [
    ContractsService,
    ContractSigningService,
    PdfStamperService,
    PdfCertificateService,
  ],
  exports: [
    ContractsService,
    ContractSigningService,
    PdfStamperService,
    PdfCertificateService,
  ],
})
export class ContractsModule {}
