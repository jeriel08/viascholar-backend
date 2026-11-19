import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const DEADLINE_REQUIREMENT_TYPES = ['ENROLLMENT', 'GRADES'] as const;
export type DeadlineRequirementType =
  (typeof DEADLINE_REQUIREMENT_TYPES)[number];

export class CreateDeadlineDto {
  @IsIn(DEADLINE_REQUIREMENT_TYPES)
  requirement_type: DeadlineRequirementType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(15)
  academic_year: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  semester: string;

  @IsDateString()
  due_date: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  school_id?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  grace_period_days?: number;

  @IsOptional()
  @IsBoolean()
  is_optional_term?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  notify_scholars?: boolean;
}

export class UpdateDeadlineDto {
  @IsOptional()
  @IsDateString()
  due_date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  school_id?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  grace_period_days?: number;

  @IsOptional()
  @IsBoolean()
  is_optional_term?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class SendDeadlineFollowUpDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  deadline_id: number;

  @IsArray()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsInt({ each: true })
  scholar_profile_ids: number[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsBoolean()
  send_chat?: boolean;

  @IsOptional()
  @IsBoolean()
  send_email?: boolean;

  @IsOptional()
  @IsBoolean()
  send_notification?: boolean;
}

export class ExemptScholarDeadlineDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  deadline_id: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  scholar_profile_id: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
