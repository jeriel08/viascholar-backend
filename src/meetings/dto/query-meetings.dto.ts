import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryMeetingsDto {
  @ApiPropertyOptional({ example: 'SCHEDULED' })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00.000Z' })
  @IsString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ example: 12 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  applicationId?: number;

  @ApiPropertyOptional({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ example: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;
}
