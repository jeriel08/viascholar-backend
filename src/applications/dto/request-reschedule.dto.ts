import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RequestRescheduleDto {
  @ApiProperty({
    example: 'Conflict with major university examination.',
    description: 'Reason why the student cannot attend the scheduled interview',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({
    example: 'Available any weekday after 2:00 PM.',
    description: 'Preferred days/times for rescheduling',
  })
  @IsString()
  @IsOptional()
  preferred_availability?: string;
}
