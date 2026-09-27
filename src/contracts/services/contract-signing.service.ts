import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { Role } from '../../generated/prisma/enums.js';
import { PdfStamperService } from './pdf-stamper.service.js';
import { RequestContractChangesDto } from '../dto/request-contract-changes.dto.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

export interface SignContractOptions {
  signatureBuffer?: Buffer;
  signatureBase64?: string;
  signerIp?: string;
  signerUserAgent?: string;
}

@Injectable()
export class ContractSigningService {
  private frontendUrl: string;

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private cloudinaryService: CloudinaryService,
    private pdfStamperService: PdfStamperService,
    private configService: ConfigService,
    private eventsGateway: EventsGateway,
    private notificationsService: NotificationsService,
  ) {
    this.frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
  }

  // Student requests revisions/corrections on a pending contract before signing
  async requestContractChanges(
    userId: number,
    contractId: number,
    dto: RequestContractChangesDto,
  ) {
    const contract = await this.prisma.contract.findUnique({
      where: { contract_id: contractId },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException(`Contract ID ${contractId} not found.`);
    }

    if (contract.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Contract ID ${contractId} not found.`);
    }

    if (contract.status === 'SIGNED') {
      throw new BadRequestException(
        'This contract has already been signed and cannot be amended via change request.',
      );
    }

    if (contract.status === 'TERMINATED') {
      throw new BadRequestException(
        'This contract has been terminated and cannot be amended.',
      );
    }

    const studentName =
      `${contract.scholar_profile.first_name} ${contract.scholar_profile.last_name}`.trim() ||
      'Student';
    const studentEmail = contract.scholar_profile.user?.email || 'N/A';

    // 1. Audit log
    await this.auditService.log(
      userId,
      'CONTRACT_CHANGE_REQUESTED',
      `Student requested changes for Contract #${contract.contract_number} (ID ${contractId}). Reason: ${dto.reason}`,
    );

    // 2. Dispatch email notification to staff
    const staffEmails = await this.mailService.getStaffEmails();
    if (staffEmails.length > 0) {
      await this.mailService.sendContractChangeRequestToStaff(staffEmails, {
        studentName,
        studentEmail,
        contractNumber: contract.contract_number,
        reason: dto.reason,
      });
    }

    this.eventsGateway.emitToStaff('contract:changes_requested', {
      contractId: contract.contract_id,
      contractNumber: contract.contract_number,
      scholarProfileId: contract.scholar_profile_id,
      studentName,
      reason: dto.reason,
      requestedAt: new Date().toISOString(),
    });

    void this.notificationsService.notifyStaff({
      title: 'Contract Revision Requested',
      message: `${studentName} requested revisions to their scholarship agreement: ${dto.reason}`,
      category: 'contract',
      link: '/CoordinatorApplicants',
    });

    return {
      message:
        'Your change request has been submitted. The scholarship staff has been notified to review and update your agreement details.',
      contract_id: contract.contract_id,
      contract_number: contract.contract_number,
      requested_reason: dto.reason,
    };
  }

  // Student signs pending contract with e-signature, PDF stamping, QR code & audit certificate
  async signContract(
    userId: number,
    contractId: number,
    options: SignContractOptions,
  ) {
    // 1. Resolve signature image buffer from uploaded file or base64 canvas data
    let sigBuffer: Buffer | null = null;

    if (options.signatureBuffer && options.signatureBuffer.length > 0) {
      sigBuffer = options.signatureBuffer;
    } else if (options.signatureBase64) {
      const cleanBase64 = options.signatureBase64.replace(
        /^data:image\/\w+;base64,/,
        '',
      );
      sigBuffer = Buffer.from(cleanBase64, 'base64');
    }

    if (!sigBuffer || sigBuffer.length === 0) {
      throw new BadRequestException(
        'A valid signature image (uploaded file or signature_base64) is required to sign the contract.',
      );
    }

    // 2. Verify contract ownership and status
    const contract = await this.prisma.contract.findUnique({
      where: { contract_id: contractId },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException(`Contract ID ${contractId} not found.`);
    }

    if (contract.scholar_profile.user_id !== userId) {
      throw new NotFoundException(`Contract ID ${contractId} not found.`);
    }

    if (contract.status === 'SIGNED') {
      throw new BadRequestException('This contract has already been signed.');
    }

    if (contract.status === 'TERMINATED') {
      throw new BadRequestException(
        'This contract has been terminated and cannot be signed.',
      );
    }

    const studentName =
      `${contract.scholar_profile.first_name} ${contract.scholar_profile.last_name}`.trim() ||
      'Scholar';
    const signedAt = new Date();

    // 3. Stamp Signature, Metadata, Verification QR Code, and Audit Certificate onto PDF
    const stampResult = await this.pdfStamperService.stampContract({
      signatureBuffer: sigBuffer,
      studentName,
      studentEmail: contract.scholar_profile?.user?.email,
      phoneNumber: contract.scholar_profile?.phone_number || undefined,
      address: contract.scholar_profile?.student_address || undefined,
      studentNumber: contract.scholar_profile?.student_number || undefined,
      schoolName: contract.scholar_profile?.school_name || undefined,
      schoolAddress: contract.scholar_profile?.school_address || undefined,
      courseName: contract.scholar_profile?.course_of_study || undefined,
      scholarshipName:
        contract.scholar_profile?.scholarship_track ||
        'Francisco & Laureanne Lorenzo Scholarship Program (FLLSP)',
      contractNumber: contract.contract_number,
      effectiveDate: contract.effective_date || undefined,
      signedAt,
      signerIp: options.signerIp,
      signerUserAgent: options.signerUserAgent,
      verificationBaseUrl: `${this.frontendUrl}/verify/contract`,
    });

    // 4. Upload Signature Image and Executed Signed PDF to Cloudinary
    const [sigUpload, pdfUpload] = await Promise.all([
      this.cloudinaryService.uploadBuffer(
        sigBuffer,
        'viascholar/signatures',
        `sig_${contract.contract_number}_${Date.now()}`,
        'image',
      ),
      this.cloudinaryService.uploadBuffer(
        stampResult.stampedPdfBuffer,
        'viascholar/signed-contracts',
        `contract_${contract.contract_number}_${stampResult.certificateId}`,
        'auto',
      ),
    ]);

    // 5. Atomically update Contract and Promote User to SCHOLAR
    const { updated, promoted } = await this.prisma.$transaction(async (tx) => {
      const contractUpdate = await tx.contract.update({
        where: { contract_id: contractId },
        data: {
          status: 'SIGNED',
          signed_at: signedAt,
          signed_by_user_id: userId,
          signed_document_url: pdfUpload.secure_url,
          signature_url: sigUpload.secure_url,
          certificate_id: stampResult.certificateId,
          document_hash: stampResult.documentHash,
          signer_ip: options.signerIp,
          signer_user_agent: options.signerUserAgent,
        },
      });

      const userUpdate = await tx.user.updateMany({
        where: {
          user_id: userId,
          role: Role.APPLICANT,
        },
        data: { role: Role.SCHOLAR },
      });

      return {
        updated: contractUpdate,
        promoted: userUpdate.count > 0,
      };
    });

    // 6. Comprehensive Audit Logging
    await this.auditService.log(
      userId,
      'CONTRACT_SIGNED',
      `User ID ${userId} signed contract ${contract.contract_number} (ID ${contractId}). ` +
        `Certificate ID: ${stampResult.certificateId}, SHA-256 Checksum: ${stampResult.documentHash}` +
        (promoted ? ' — applicant promoted to SCHOLAR.' : '.'),
    );

    // 7. Dispatch Email Notifications with Signed Contract URL
    const studentEmail = contract.scholar_profile?.user?.email;

    if (studentEmail) {
      this.mailService.sendContractSignedStudent(studentEmail, {
        studentName,
        contractNumber: contract.contract_number,
      });
    }

    void this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        this.mailService.sendContractSignedStaff(staffEmails, {
          studentName,
          contractNumber: contract.contract_number,
        });
      }
    });

    const signedPayload = {
      contractId: contract.contract_id,
      contractNumber: contract.contract_number,
      scholarProfileId: contract.scholar_profile_id,
      studentName,
      certificateId: stampResult.certificateId,
      status: 'SIGNED',
      signedAt,
    };
    this.eventsGateway.emitToStaff('contract:signed', signedPayload);
    this.eventsGateway.emitToUser(userId, 'contract:signed', signedPayload);

    void this.notificationsService.notifyUser(userId, {
      title: 'Agreement Signed',
      message: 'You have successfully signed your scholarship agreement!',
      category: 'contract',
      link: '/ApplicantsContract',
    });

    void this.notificationsService.notifyStaff({
      title: 'Agreement Signed',
      message: `${studentName} has signed their scholarship agreement.`,
      category: 'contract',
      link: '/CoordinatorApplicants',
    });

    if (promoted) {
      const promotionPayload = {
        userId,
        oldRole: 'APPLICANT',
        newRole: 'SCHOLAR',
        studentName,
        promotedAt: signedAt.toISOString(),
      };
      this.eventsGateway.emitToStaff('user:role_promoted', promotionPayload);
      this.eventsGateway.emitToUser(
        userId,
        'user:role_promoted',
        promotionPayload,
      );

      void this.notificationsService.notifyUser(userId, {
        title: 'Role Promoted 🎉',
        message:
          'Congratulations! You have been officially promoted to Scholar!',
        category: 'system',
        link: '/scholardashboard',
      });

      void this.notificationsService.notifyStaff({
        title: 'Applicant Promoted 🎉',
        message: `${studentName} has signed their scholarship agreement and is now officially a Scholar.`,
        category: 'system',
        link: '/CoordinatorApplicants',
      });
    }

    return updated;
  }
}
