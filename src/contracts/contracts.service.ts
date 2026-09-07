import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { PdfStamperService } from './pdf-stamper.service.js';
import { ContractStatus, Role } from '../generated/prisma/enums.js';
import { CreateContractDto } from './dto/create-contract.dto.js';
import { RequestContractChangesDto } from './dto/request-contract-changes.dto.js';

export interface SignContractOptions {
  signatureBuffer?: Buffer;
  signatureBase64?: string;
  signerIp?: string;
  signerUserAgent?: string;
}

@Injectable()
export class ContractsService {
  private frontendUrl: string;

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private cloudinaryService: CloudinaryService,
    private pdfStamperService: PdfStamperService,
    private configService: ConfigService,
  ) {
    this.frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
  }

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

    return {
      message:
        'Your change request has been submitted. The scholarship staff has been notified to review and update your agreement details.',
      contract_id: contract.contract_id,
      contract_number: contract.contract_number,
      requested_reason: dto.reason,
    };
  }

  // 4. Student signs pending contract with e-signature, PDF stamping, QR code & audit certificate
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

    this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        this.mailService.sendContractSignedStaff(staffEmails, {
          studentName,
          contractNumber: contract.contract_number,
        });
      }
    });

    return updated;
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
