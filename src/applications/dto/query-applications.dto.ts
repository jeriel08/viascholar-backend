import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApplicationStatus } from '../../generated/prisma/enums.js';

export class QueryApplicationsDto {
  @ApiPropertyOptional({ enum: ApplicationStatus })
  @IsEnum(ApplicationStatus)
  @IsOptional()
  status?: ApplicationStatus;

  @ApiPropertyOptional({ example: 'Academic Track' })
  @IsString()
  @IsOptional()
  track?: string;

  @ApiPropertyOptional({ example: 'Donna' })
  @IsString()
  @IsOptional()
  search?: string;
}
