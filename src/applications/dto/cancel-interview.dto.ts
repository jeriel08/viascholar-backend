import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CancelInterviewDto {
  @ApiPropertyOptional({
    example: 'Applicant requested a later date.',
    description: 'Reason recorded for the cancellation',
  })
  @IsString()
  @IsOptional()
  reason?: string;
}
