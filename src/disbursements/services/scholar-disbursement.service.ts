import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { LlamaExtractService } from '../../documents/extractors/llama-extract.service.js';
import { SubmitOfficialReceiptDto } from '../dto/disbursement.dto.js';

@Injectable()
export class ScholarDisbursementService {
  private readonly logger = new Logger(ScholarDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
    private readonly cloudinaryService: CloudinaryService,
    private readonly llamaExtractService: LlamaExtractService,
  ) {}

  private async getScholarProfile(userId: number) {
    const profile = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });
    if (!profile) {
      throw new NotFoundException('Scholar profile not found.');
    }
    return profile;
  }

  // 1. Get all disbursements for the logged-in scholar
  async getMyDisbursements(userId: number) {
    const profile = await this.getScholarProfile(userId);

    const disbursements = await this.prisma.disbursement.findMany({
      where: { scholar_profile_id: profile.profile_id },
      orderBy: { created_at: 'desc' },
      include: {
        or_document: true,
        term_enrollment: {
          include: {
            cor_document: true,
            soa_document: true,
          },
        },
      },
    });

    return disbursements;
  }

  // 2. Scholar uploads and scans Official Receipt (Cloudinary + LlamaExtract OCR)
  async uploadAndScanReceipt(userId: number, files: Express.Multer.File[]) {
    await this.getScholarProfile(userId);

    if (!files || files.length === 0) {
      throw new BadRequestException('No receipt file provided.');
    }

    const file = files[0];
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Please upload a JPG, PNG, WEBP, or PDF of your Official Receipt.',
      );
    }

    if (file.size > 15 * 1024 * 1024) {
      throw new BadRequestException('File size must not exceed 15MB.');
    }

    // 1. Upload to Cloudinary
    const uploadResult = await this.cloudinaryService.uploadDocument(
      file,
      'viascholar/disbursements/receipts',
    );

    // 2. Extract OCR data with LlamaParse
    let extractedData: any = null;
    try {
      extractedData = await this.llamaExtractService.extractOfficialReceiptData({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to OCR Official Receipt "${file.originalname}": ${err?.message || err}`,
      );
    }

    return {
      file_url: uploadResult.secure_url,
      file_name: file.originalname,
      file_size: `${(file.size / 1024).toFixed(1)} KB`,
      extracted_data: extractedData,
    };
  }

  // 3. Scholar submits university Official Receipt photo and details
  async submitOfficialReceipt(
    userId: number,
    disbursementId: number,
    dto: SubmitOfficialReceiptDto,
  ) {
    const profile = await this.getScholarProfile(userId);

    const disbursement = await this.prisma.disbursement.findUnique({
      where: { disbursement_id: disbursementId },
    });

    if (!disbursement) {
      throw new NotFoundException(`Disbursement #${disbursementId} not found.`);
    }

    if (disbursement.scholar_profile_id !== profile.profile_id) {
      throw new BadRequestException('You are not authorized to submit receipt for this disbursement.');
    }

    if (disbursement.status !== 'CHECK_ISSUED' && disbursement.status !== 'OR_SUBMITTED' && disbursement.status !== 'AUTHORIZED' && disbursement.status !== 'RELEASED') {
      throw new BadRequestException(`Cannot submit Official Receipt when disbursement status is "${disbursement.status}".`);
    }

    // Save Official Receipt document & update disbursement in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create or update ScholarDocument for Official Receipt
      const orDoc = await tx.scholarDocument.create({
        data: {
          scholar_profile_id: profile.profile_id,
          document_type: 'OFFICIAL_RECEIPT',
          label: `Official Receipt - ${disbursement.academic_year} ${disbursement.semester}`,
          file_name: dto.file_name || `Official_Receipt_${dto.or_number}.pdf`,
          file_url: dto.file_url,
          file_size: 'Uploaded',
          file_type: 'IMAGE_OR_PDF',
          status: 'PENDING',
          extracted_data: (dto.extracted_data as any) || undefined,
        },
      });

      // 2. Update Disbursement with OR metadata
      const updatedDisbursement = await tx.disbursement.update({
        where: { disbursement_id: disbursementId },
        data: {
          status: 'OR_SUBMITTED',
          or_number: dto.or_number.trim(),
          or_payment_date: new Date(dto.or_payment_date),
          or_document_id: orDoc.document_id,
          date_claimed: disbursement.date_claimed || new Date(),
          remarks: dto.remarks
            ? `${disbursement.remarks || ''}\nScholar OR Submission: ${dto.remarks}`.trim()
            : disbursement.remarks,
        },
        include: {
          or_document: true,
          scholar_profile: true,
        },
      });

      return { updatedDisbursement, orDoc };
    });

    await this.auditService.log(
      userId,
      'SUBMIT_OFFICIAL_RECEIPT',
      `Scholar ${profile.first_name} ${profile.last_name} submitted Official Receipt #${dto.or_number} for disbursement #${disbursementId}`,
    );

    // Notify staff of new OR pending verification
    this.eventsGateway.emitToStaff('disbursement:or_submitted', {
      disbursement_id: result.updatedDisbursement.disbursement_id,
      or_number: dto.or_number,
      scholar_name: `${profile.first_name} ${profile.last_name}`,
      school_name: profile.school_name,
      amount: result.updatedDisbursement.amount,
    });

    this.eventsGateway.emitToStaff('disbursement:updated', {
      disbursement_id: result.updatedDisbursement.disbursement_id,
      status: 'OR_SUBMITTED',
    });

    return {
      message: 'Official Receipt successfully submitted for coordinator verification.',
      disbursement: result.updatedDisbursement,
    };
  }
}
