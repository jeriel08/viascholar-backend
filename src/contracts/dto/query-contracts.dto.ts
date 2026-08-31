import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ContractStatus } from '../../generated/prisma/enums.js';

export class QueryContractsDto {
  @ApiPropertyOptional({ enum: ContractStatus, example: 'PENDING' })
  @IsEnum(ContractStatus)
  @IsOptional()
  status?: ContractStatus;
}
