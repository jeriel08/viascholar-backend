import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EnrolledSubjectItemDto {
  @IsString()
  subject_code: string;

  @IsString()
  descriptive_title: string;

  @IsNumber()
  units: number;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  schedule?: string;

  @IsOptional()
  @IsString()
  room?: string;

  @IsOptional()
  @IsArray()
  prerequisites?: string[];

  @IsOptional()
  @IsString()
  status?: string; // e.g. "ON_TRACK", "OFF_TRACK", "PREREQUISITE_CLEARED", "MISSING_PREREQUISITE"
}

export class BillingBreakdownDto {
  @IsOptional()
  @IsNumber()
  tuition_fee?: number;

  @IsOptional()
  @IsNumber()
  lab_fees?: number;

  @IsOptional()
  @IsNumber()
  misc_fees?: number;

  @IsOptional()
  @IsNumber()
  other_fees?: number;

  @IsOptional()
  @IsNumber()
  previous_balance?: number;

  @IsOptional()
  @IsNumber()
  discounts?: number;

  @IsOptional()
  @IsNumber()
  net_balance_due?: number;
}

export class SubmitEnrollmentDto {
  @IsString()
  academic_year: string; // e.g. "2026-2027"

  @IsString()
  semester: string; // "1st Semester", "2nd Semester", "Summer"

  @IsInt()
  year_level: number;

  @IsOptional()
  @IsBoolean()
  is_consolidated?: boolean;

  @IsOptional()
  @IsInt()
  cor_document_id?: number;

  @IsOptional()
  @IsInt()
  soa_document_id?: number;

  @IsNumber()
  total_units: number;

  @IsNumber()
  total_assessment: number;

  @IsOptional()
  @IsDateString()
  assessment_date?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnrolledSubjectItemDto)
  enrolled_subjects: EnrolledSubjectItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => BillingBreakdownDto)
  billing_breakdown?: BillingBreakdownDto;
}
