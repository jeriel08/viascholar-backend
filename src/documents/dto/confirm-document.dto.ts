// src/documents/dto/confirm-document.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GradeItemDto } from './grade-item.dto.js';

export class ConfirmDocumentDto {
  @ApiPropertyOptional({ example: 'AY 2025-2026 1st Sem' })
  @IsString()
  @IsOptional()
  academic_year?: string;

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
