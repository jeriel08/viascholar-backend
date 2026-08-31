import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class CreateContractDto {
  @ApiProperty({
    example: 1,
    description: 'Scholar profile that will receive the contract',
  })
  @IsInt()
  @IsPositive()
  scholar_profile_id: number;

  @ApiProperty({ example: 'VS-2026-0001' })
  @IsString()
  @IsNotEmpty()
  contract_number: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Date the scholarship takes effect',
  })
  @IsDateString()
  @IsOptional()
  effective_date?: string;

  @ApiPropertyOptional({
    example: '2027-05-31',
    description: 'Date the scholarship expires',
  })
  @IsDateString()
  @IsOptional()
  expiry_date?: string;

  @ApiPropertyOptional({
    description: 'URL of the contract document (e.g., Cloudinary file)',
  })
  @IsString()
  @IsOptional()
  document_url?: string;
}
