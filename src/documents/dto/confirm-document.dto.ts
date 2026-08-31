import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GradeItemDto } from './grade-item.dto.js';

export class ConfirmDocumentDto {
  @ApiPropertyOptional({
    example: '2017-2018',
    description: 'Academic year or period (e.g. 2017-2018, AY 2025-2026 1st Sem)',
  })
  @IsString()
  @IsOptional()
  academic_year?: string;

  @ApiPropertyOptional({
    example: 86.0,
    description:
      'Official General Average / GWA directly extracted or confirmed from report card',
  })
  @IsNumber()
  @IsOptional()
  general_average?: number;

  @ApiPropertyOptional({
    type: [GradeItemDto],
    description:
      'Student-corrected grade items; merged over the OCR extracted data',
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => GradeItemDto)
  grade_items?: GradeItemDto[];
}

