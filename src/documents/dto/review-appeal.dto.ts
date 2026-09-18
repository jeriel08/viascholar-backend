import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ReviewAppealDto {
  @ApiProperty({
    description: 'Grantor verdict on second chance appeal',
    enum: ['APPROVED', 'DENIED'],
    example: 'APPROVED',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['APPROVED', 'DENIED'])
  decision: 'APPROVED' | 'DENIED';

  @ApiPropertyOptional({
    description: 'Grantor comments, conditions, or termination remarks',
    example: 'Second chance granted on probationary status. Must achieve minimum 2.0 GWA next term.',
  })
  @IsString()
  @IsOptional()
  decision_notes?: string;

  @ApiPropertyOptional({
    description: 'Whether to place the scholar on PROBATIONARY_ACTIVE standing',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  grant_probation?: boolean;
}
