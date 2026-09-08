import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RequestGrantorDto {
  @ApiProperty({
    example: 7,
    description: 'Grantor user ID to request message access from',
  })
  @IsInt()
  @IsNotEmpty()
  grantor_user_id!: number;

  @ApiProperty({
    example: 'Inquiry regarding scholarship project submission guidelines',
    description: 'Reason for requesting message permission',
  })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiPropertyOptional({
    example: 'Project Support Inquiry',
    description: 'Subject of conversation request',
  })
  @IsString()
  @IsOptional()
  subject?: string;
}
