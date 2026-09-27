import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { PdfStamperService } from './services/pdf-stamper.service.js';
import {
  ContractSigningService,
  SignContractOptions,
} from './services/contract-signing.service.js';
import { ContractStatus } from '../generated/prisma/enums.js';
import { CreateContractDto } from './dto/create-contract.dto.js';
import { RequestContractChangesDto } from './dto/request-contract-changes.dto.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export type { SignContractOptions };

@Injectable()
export class ContractsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private cloudinaryService: CloudinaryService,
    private pdfStamperService: PdfStamperService,
    private contractSigningService: ContractSigningService,
    private eventsGateway: EventsGateway,
    private notificationsService: NotificationsService,
  ) {}

  // 1. Staff creates a pending contract for a scholar with an approved application
  async createContract(actorUserId: number, dto: CreateContractDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: dto.scholar_profile_id },
      include: {
        applications: { orderBy: { submitted_at: 'desc' }, take: 1 },
        user: true,
      },
    });

    if (!scholar) {
      throw new NotFoundException(
        `Scholar profile ID ${dto.scholar_profile_id} not found.`,
      );
    }

    const latestApplication = scholar.applications[0];
    if (!latestApplication || latestApplication.status !== 'APPROVED') {
      throw new BadRequestException(
        'A contract can only be created after the grantor has approved the latest application.',
      );
    }

    const studentEmail = scholar.user?.email;
    const studentName =
      `${scholar.first_name} ${scholar.last_name}`.trim() || 'Student';
    const effectiveDate = dto.effective_date
      ? new Date(dto.effective_date)
      : undefined;

    // Auto-generate unsigned draft PDF with pre-filled student details
    const draftPdfBuffer = await this.pdfStamperService.generateUnsignedDraft({
      studentName,
      studentEmail,
      phoneNumber: scholar.phone_number || undefined,
      address: scholar.student_address || undefined,
      studentNumber: scholar.student_number || undefined,
      schoolName: scholar.school_name || undefined,
      schoolAddress: scholar.school_address || undefined,
      courseName: scholar.course_of_study || undefined,
      scholarshipName:
        scholar.scholarship_track ||
        'Francisco & Laureanne Lorenzo Scholarship Program (FLLSP)',
      contractNumber: dto.contract_number,
      effectiveDate,
    });

    // Upload unsigned preview PDF to Cloudinary
    const draftUpload = await this.cloudinaryService.uploadBuffer(
      draftPdfBuffer,
      'viascholar/draft-contracts',
      `draft_${dto.contract_number}_${Date.now()}`,
      'auto',
    );

    const contract = await this.prisma.contract.create({
      data: {
        scholar_profile_id: dto.scholar_profile_id,
        contract_number: dto.contract_number,
        status: 'PENDING',
        effective_date: effectiveDate,
        expiry_date: dto.expiry_date ? new Date(dto.expiry_date) : undefined,
        document_url: draftUpload.secure_url,
      },
    });

    await this.auditService.log(
      actorUserId,
      'CONTRACT_CREATED',
      `Contract ${dto.contract_number} created for scholar profile ID ${dto.scholar_profile_id}.`,
    );

    // Notify student that contract is ready for review and signing
    if (studentEmail) {
      this.mailService.sendContractReadyToSign(studentEmail, {
        studentName,
        contractNumber: dto.contract_number,
      });
    }

    const contractPayload = {
      contractId: contract.contract_id,
      contractNumber: contract.contract_number,
      scholarProfileId: contract.scholar_profile_id,
      studentName,
      status: contract.status,
      issuedAt: new Date().toISOString(),
    };
    this.eventsGateway.emitToStaff('contract:created', contractPayload);
    if (scholar.user_id) {
      this.eventsGateway.emitToUser(
        scholar.user_id,
        'contract:created',
        contractPayload,
      );

      void this.notificationsService.notifyUser(scholar.user_id, {
        title: 'Scholarship Agreement Ready',
        message: 'Your scholarship agreement is ready for review and signing!',
        category: 'contract',
        link: '/ApplicantsContract',
      });
    }

    void this.notificationsService.notifyStaff({
      title: 'Scholarship Agreement Ready',
      message: `A scholarship agreement has been prepared for ${studentName}.`,
      category: 'contract',
      link: '/CoordinatorApplicants',
    });

    return contract;
  }

  // 2. Staff lists all contracts, optionally filtered by status
  async findAll(status?: ContractStatus) {
    return this.prisma.contract.findMany({
      where: status ? { status } : undefined,
      orderBy: { contract_id: 'desc' },
      include: {
        scholar_profile: { include: { user: true } },
        signed_by_user: true,
      },
    });
  }

  // 3. Scholar views their own contracts
  async getMyContracts(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    return this.prisma.contract.findMany({
      where: { scholar_profile_id: scholar.profile_id },
      orderBy: { contract_id: 'desc' },
    });
  }

  // 3b. Student requests revisions/corrections on a pending contract before signing
  requestContractChanges(
    userId: number,
    contractId: number,
    dto: RequestContractChangesDto,
  ) {
    return this.contractSigningService.requestContractChanges(
      userId,
      contractId,
      dto,
    );
  }

  // 4. Student signs pending contract with e-signature, PDF stamping, QR code & audit certificate
  signContract(
    userId: number,
    contractId: number,
    options: SignContractOptions,
  ) {
    return this.contractSigningService.signContract(
      userId,
      contractId,
      options,
    );
  }

  // 5. Public Certificate & Contract Verification (QR Code Scan Lookup)
  async verifyContract(certificateId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { certificate_id: certificateId },
      include: {
        scholar_profile: true,
      },
    });

    if (!contract) {
      throw new NotFoundException(
        `Contract certificate '${certificateId}' was not found or is invalid.`,
      );
    }

    return {
      valid: contract.status === 'SIGNED',
      certificate_id: contract.certificate_id,
      contract_number: contract.contract_number,
      status: contract.status,
      student_name:
        `${contract.scholar_profile.first_name} ${contract.scholar_profile.last_name}`.trim(),
      student_number: contract.scholar_profile.student_number || 'N/A',
      school_name: contract.scholar_profile.school_name || 'N/A',
      scholarship_track:
        contract.scholar_profile.scholarship_track || 'General',
      effective_date: contract.effective_date,
      signed_at: contract.signed_at,
      document_hash: contract.document_hash,
      signed_document_url: contract.signed_document_url,
    };
  }
}
