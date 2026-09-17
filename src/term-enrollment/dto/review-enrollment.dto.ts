import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EnrolledSubjectItemDto } from './submit-enrollment.dto.js';

export enum EnrollmentReviewAction {
  APPROVE = 'APPROVE',
  REQUEST_CHANGES = 'REQUEST_CHANGES',
  REJECT = 'REJECT',
}

export class ReviewEnrollmentDto {
  @IsEnum(EnrollmentReviewAction)
  action: EnrollmentReviewAction;

  @IsOptional()
  @IsString()
  coordinator_notes?: string;

  @IsOptional()
  @IsNumber()
  approved_amount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnrolledSubjectItemDto)
  adjusted_subjects?: EnrolledSubjectItemDto[];
}
