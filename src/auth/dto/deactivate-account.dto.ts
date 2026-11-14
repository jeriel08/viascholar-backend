import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeactivateAccountDto {
  @ApiPropertyOptional({
    description: 'Optional reason for deactivating the account',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Optional current password confirmation',
  })
  @IsOptional()
  @IsString()
  password?: string;
}
