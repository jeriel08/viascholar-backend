import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { ContractsService } from './contracts.service.js';
import { CreateContractDto } from './dto/create-contract.dto.js';
import { QueryContractsDto } from './dto/query-contracts.dto.js';
import { RequestContractChangesDto } from './dto/request-contract-changes.dto.js';
import { SignContractDto } from './dto/sign-contract.dto.js';

@ApiTags('Scholarship Contracts')
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({
    summary: 'Create a pending contract for an approved scholar (Staff only)',
  })
  create(@Request() req, @Body() dto: CreateContractDto) {
    return this.contractsService.createContract(req.user.user_id, dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({ summary: 'List own scholarship contracts' })
  getMyContracts(@Request() req) {
    return this.contractsService.getMyContracts(req.user.user_id);
  }

  @Get('verify/:certificateId')
  @ApiOperation({
    summary:
      'Public verification of contract authenticity by Certificate ID (QR Code scan target)',
  })
  verifyContract(@Param('certificateId') certificateId: string) {
    return this.contractsService.verifyContract(certificateId);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'List all contracts with optional status filter (Staff only)',
  })
  findAll(@Query() query: QueryContractsDto) {
    return this.contractsService.findAll(query.status);
  }

  @Post(':id/request-changes')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary:
      'Request corrections/revisions on a pending contract before signing (Student only)',
  })
  requestChanges(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RequestContractChangesDto,
  ) {
    return this.contractsService.requestContractChanges(
      req.user.user_id,
      id,
      dto,
    );
  }

  @Patch(':id/sign')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @UseInterceptors(FileInterceptor('signature'))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    description:
      'Sign contract by uploading a signature PNG file OR sending signature_base64 string',
    schema: {
      type: 'object',
      properties: {
        signature: {
          type: 'string',
          format: 'binary',
          description: 'Signature PNG file (multipart)',
        },
        signature_base64: {
          type: 'string',
          description: 'Base64 data URL from signature canvas pad',
        },
      },
    },
  })
  @ApiOperation({
    summary:
      'Sign scholarship contract with e-signature upload/canvas, PDF stamping, and QR certificate generation',
  })
  sign(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file?: Express.Multer.File,
    @Body() dto?: SignContractDto,
  ) {
    const signerIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      req.ip;
    const signerUserAgent = req.headers['user-agent'] as string;

    return this.contractsService.signContract(req.user.user_id, id, {
      signatureBuffer: file?.buffer,
      signatureBase64: dto?.signature_base64,
      signerIp,
      signerUserAgent,
    });
  }
}
