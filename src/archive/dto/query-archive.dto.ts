import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const ARCHIVE_ENTITIES = [
  'scholar',
  'graduate',
  'applicant',
  'school',
  'program',
] as const;

export type ArchiveEntity = (typeof ARCHIVE_ENTITIES)[number];

export class QueryArchiveDto {
  @ApiPropertyOptional({
    enum: ARCHIVE_ENTITIES,
    default: 'scholar',
    description: 'Which archived or graduated record type to list',
  })
  @IsIn(ARCHIVE_ENTITIES as unknown as string[])
  @IsOptional()
  entity?: ArchiveEntity;

  @ApiPropertyOptional({
    example: 'GRADUATED',
    description: 'Filter by archive reason',
  })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({
    example: '2024',
    description: 'Filter graduated scholars by 4-digit graduation year',
  })
  @IsString()
  @IsOptional()
  year?: string;

  @ApiPropertyOptional({
    example: 'donna',
    description: 'Search by name, email, student number, school or program',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}
