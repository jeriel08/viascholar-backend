import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class FreezeBaselineDto {
  @ApiPropertyOptional({
    example: 'Verified against UM BSIT 2023 catalog evaluation sheet.',
    description: 'Coordinator notes upon freezing the baseline',
  })
  @IsString()
  @IsOptional()
  remarks?: string;
}
