import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class UpdateCommentDto {
  @ApiProperty({
    example:
      'Updated guidance: upload both pages together and the system merges them into one PDF.',
    description: 'Updated comment or answer text',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  content!: string;
}
