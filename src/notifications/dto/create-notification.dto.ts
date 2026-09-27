import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateNotificationDto {
  @ApiProperty({ description: 'Notification title' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ description: 'Notification message body' })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiPropertyOptional({
    description: 'Notification category',
    default: 'system',
    example: 'application',
  })
  @IsString()
  @IsOptional()
  category?: string = 'system';

  @ApiPropertyOptional({
    description: 'Optional deep link for redirection on click',
    example: '/CoordinatorApplicants',
  })
  @IsString()
  @IsOptional()
  link?: string;
}
