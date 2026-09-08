import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class RespondRequestDto {
  @ApiProperty({
    example: 'ACCEPT',
    enum: ['ACCEPT', 'REJECT'],
    description: 'Accept or decline the message request',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['ACCEPT', 'REJECT'])
  action!: 'ACCEPT' | 'REJECT';
}
