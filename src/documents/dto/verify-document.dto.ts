// src/documents/dto/verify-document.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GradeItemDto } from './grade-item.dto.js';

export class VerifyDocumentDto {
  @ApiProperty({ example: 'AY 2025-2026 1st Sem' })
  @IsString()
  @IsNotEmpty()
  academic_year: string;

  @ApiProperty({ type: [GradeItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GradeItemDto)
  grade_items: GradeItemDto[];

  @ApiPropertyOptional({
    example: 'Image was blurry on subject 2, manually updated grade.',
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
