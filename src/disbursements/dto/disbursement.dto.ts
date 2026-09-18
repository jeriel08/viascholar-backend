import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export enum DisbursementStatusFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CHECK_ISSUED = 'CHECK_ISSUED',
  OR_SUBMITTED = 'OR_SUBMITTED',
  SETTLED = 'SETTLED',
  CANCELLED = 'CANCELLED',
}

export class AuthorizeDisbursementBatchDto {
  @IsArray()
  @IsInt({ each: true })
  disbursement_ids: number[];

  @IsOptional()
  @IsString()
  voucher_prefix?: string;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class RecordCheckIssuanceDto {
  @IsNotEmpty()
  @IsString()
  check_number: string;

  @IsNotEmpty()
  @IsString()
  bank_name: string;

  @IsNotEmpty()
  @IsDateString()
  date_issued: string;

  @IsOptional()
  @IsString()
  voucher_number?: string;

  @IsOptional()
  @IsString()
  payment_method?: string;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class SubmitOfficialReceiptDto {
  @IsNotEmpty()
  @IsString()
  or_number: string;

  @IsNotEmpty()
  @IsDateString()
  or_payment_date: string;

  @IsNotEmpty()
  @IsString()
  file_url: string;

  @IsOptional()
  @IsString()
  file_name?: string;

  @IsOptional()
  extracted_data?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class SettleOfficialReceiptDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsOptional()
  @IsString()
  rejection_reason?: string;
}
