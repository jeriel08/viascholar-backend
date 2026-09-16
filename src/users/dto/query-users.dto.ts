import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Role } from '../../generated/prisma/enums.js';

export class QueryUsersDto {
  @ApiPropertyOptional({ enum: Role })
  @IsEnum(Role)
  @IsOptional()
  role?: Role;

  @ApiPropertyOptional({ example: 'APPLICANT,SCHOLAR' })
  @IsString()
  @IsOptional()
  roles?: string;

  @ApiPropertyOptional({ example: 'donna' })
  @IsString()
  @IsOptional()
  search?: string;
}
