import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({
    example: 'Hello Coordinator, I have uploaded my updated transcript.',
    description: 'Message body text',
  })
  @IsString()
  @IsNotEmpty()
  message_text!: string;
}
