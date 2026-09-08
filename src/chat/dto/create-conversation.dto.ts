import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateConversationDto {
  @ApiProperty({
    example: 5,
    description: 'Target user ID (Scholar or Coordinator)',
  })
  @IsInt()
  @IsNotEmpty()
  target_user_id!: number;

  @ApiPropertyOptional({
    example: 'Question regarding TOR document',
    description: 'Subject of conversation',
  })
  @IsString()
  @IsOptional()
  subject?: string;
}
