import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GradeItemDto } from './grade-item.dto.js';

export class VerifyDocumentDto {
  @ApiPropertyOptional({
    example: 'AY 2025-2026 1st Sem',
    description:
      'Optional override. Falls back to the student-confirmed academic year when omitted.',
  })
  @IsString()
  @IsOptional()
  academic_year?: string;

  @ApiPropertyOptional({
    example: 86.0,
    description:
      'Optional override for the official General Average / GWA. Falls back to student confirmed or extracted average when omitted.',
  })
  @IsNumber()
  @IsOptional()
  general_average?: number;

  @ApiPropertyOptional({
    type: [GradeItemDto],
    description:
      'Optional override. Omit to evaluate using the student-confirmed grade items instead.',
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => GradeItemDto)
  grade_items?: GradeItemDto[];

  @ApiPropertyOptional({
    example: 'Image was blurry on subject 2, manually updated grade.',
  })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Allows Coordinator/Grantor/Admin to verify a bypassed or unconfirmed document directly from Scholar Details.',
  })
  @IsBoolean()
  @IsOptional()
  bypass_student_confirmation?: boolean;
}
