import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { GrantorDisbursementService } from './services/grantor-disbursement.service.js';
import { CoordinatorDisbursementService } from './services/coordinator-disbursement.service.js';
import { ScholarDisbursementService } from './services/scholar-disbursement.service.js';
import {
  AuthorizeDisbursementBatchDto,
  RecordCheckIssuanceDto,
  SettleOfficialReceiptDto,
  SubmitOfficialReceiptDto,
} from './dto/disbursement.dto.js';

@ApiTags('Disbursements')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('disbursements')
export class DisbursementsController {
  constructor(
    private readonly grantorService: GrantorDisbursementService,
    private readonly coordinatorService: CoordinatorDisbursementService,
    private readonly scholarService: ScholarDisbursementService,
  ) {}

  // ==========================================
  // GRANTOR ENDPOINTS
  // ==========================================

  @Get('grantor/consolidated-report')
  @Roles(Role.GRANTOR, Role.ADMIN)
  @ApiOperation({ summary: 'Get consolidated billing report of coordinator-approved SOAs grouped by university' })
  async getConsolidatedBillingReport(
    @Query('academic_year') academicYear?: string,
    @Query('semester') semester?: string,
  ) {
    return this.grantorService.getConsolidatedBillingReport(academicYear, semester);
  }

  @Post('grantor/authorize-batch')
  @Roles(Role.GRANTOR, Role.ADMIN)
  @ApiOperation({ summary: 'Grantor authorizes release of funds and generates Disbursement Voucher (DV-YYYY-XXXX)' })
  async authorizeBatch(
    @Request() req: any,
    @Body() dto: AuthorizeDisbursementBatchDto,
  ) {
    return this.grantorService.authorizeBatch(req.user.user_id, dto);
  }

  @Get('grantor/voucher/:voucherNumber')
  @Roles(Role.GRANTOR, Role.COORDINATOR, Role.ADMIN)
  @ApiOperation({ summary: 'Get details of a specific disbursement voucher' })
  async getVoucherDetails(@Param('voucherNumber') voucherNumber: string) {
    return this.grantorService.getVoucherDetails(voucherNumber);
  }

  // ==========================================
  // COORDINATOR & SHARED QUEUE ENDPOINTS
  // ==========================================

  @Get('queue')
  @Roles(Role.COORDINATOR, Role.GRANTOR, Role.ADMIN)
  @ApiOperation({ summary: 'Get full queue of disbursements with filters' })
  async getDisbursementsQueue(
    @Query('status') status?: string,
    @Query('school') school?: string,
    @Query('search') search?: string,
    @Query('academic_year') academicYear?: string,
    @Query('semester') semester?: string,
  ) {
    return this.coordinatorService.getDisbursementsQueue({
      status,
      school,
      search,
      academicYear,
      semester,
    });
  }

  @Post('coordinator/:id/issue-check')
  @Roles(Role.COORDINATOR, Role.ADMIN)
  @ApiOperation({ summary: 'Record physical check metadata with payee locked to university name' })
  async recordCheckIssuance(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordCheckIssuanceDto,
  ) {
    return this.coordinatorService.recordCheckIssuance(req.user.user_id, id, dto);
  }

  @Post('coordinator/:id/settle-or')
  @Roles(Role.COORDINATOR, Role.ADMIN)
  @ApiOperation({ summary: 'Coordinator verifies uploaded Official Receipt and settles transaction' })
  async settleOfficialReceipt(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SettleOfficialReceiptDto,
  ) {
    return this.coordinatorService.settleOfficialReceipt(req.user.user_id, id, dto);
  }

  // ==========================================
  // SCHOLAR ENDPOINTS
  // ==========================================

  @Post('scholar/upload-receipt')
  @Roles(Role.SCHOLAR)
  @UseInterceptors(AnyFilesInterceptor())
  @ApiOperation({ summary: 'Scholar uploads and scans Official Receipt (Cloudinary + OCR)' })
  async uploadReceipt(
    @Request() req: any,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.scholarService.uploadAndScanReceipt(req.user.user_id, files);
  }

  @Get('scholar/my-disbursements')
  @Roles(Role.SCHOLAR)
  @ApiOperation({ summary: 'Get personal tuition disbursement timeline for scholar' })
  async getMyDisbursements(@Request() req: any) {
    return this.scholarService.getMyDisbursements(req.user.user_id);
  }

  @Post('scholar/:id/submit-or')
  @Roles(Role.SCHOLAR)
  @ApiOperation({ summary: 'Scholar submits university Official Receipt photo and details' })
  async submitOfficialReceipt(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitOfficialReceiptDto,
  ) {
    return this.scholarService.submitOfficialReceipt(req.user.user_id, id, dto);
  }
}
