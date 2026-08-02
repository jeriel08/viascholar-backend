import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, Max } from 'class-validator';

export class UpdateSettingsDto {
  @ApiProperty({
    example: 90.0,
    description: 'Mandatory GWA retention threshold percentage',
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  grade_threshold: number;
}
