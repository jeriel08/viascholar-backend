import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { ContractStatus, Role } from '../generated/prisma/enums.js';
import { CreateContractDto } from './dto/create-contract.dto.js';

@Injectable()
export class ContractsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
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

    const contract = await this.prisma.contract.create({
      data: {
        scholar_profile_id: dto.scholar_profile_id,
        contract_number: dto.contract_number,
        status: 'PENDING',
        effective_date: dto.effective_date
          ? new Date(dto.effective_date)
          : undefined,
        expiry_date: dto.expiry_date ? new Date(dto.expiry_date) : undefined,
        document_url: dto.document_url,
      },
    });

    await this.auditService.log(
      actorUserId,
      'CONTRACT_CREATED',
      `Contract ${dto.contract_number} created for scholar profile ID ${dto.scholar_profile_id}.`,
    );

    // Notify student that contract is ready for review and signing
    const studentEmail = scholar.user?.email;
    const studentName =
      `${scholar.first_name} ${scholar.last_name}`.trim() || 'Student';

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

  // 4. Student signs their own pending contract and is promoted from APPLICANT to SCHOLAR
  async signContract(userId: number, contractId: number) {
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

    const { updated, promoted } = await this.prisma.$transaction(async (tx) => {
      const contractUpdate = await tx.contract.update({
        where: { contract_id: contractId },
        data: {
          status: 'SIGNED',
          signed_at: new Date(),
          signed_by_user_id: userId,
        },
      });

      // Promote the user to SCHOLAR if they are currently an APPLICANT
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

    await this.auditService.log(
      userId,
      'CONTRACT_SIGNED',
      `User ID ${userId} signed contract ${contract.contract_number} (ID ${contractId})` +
        (promoted ? ' and was promoted to SCHOLAR.' : '.'),
    );

    // Send contract signed confirmation emails
    const studentEmail = contract.scholar_profile?.user?.email;
    const studentName =
      `${contract.scholar_profile?.first_name} ${contract.scholar_profile?.last_name}`.trim() ||
      'Scholar';

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
}

