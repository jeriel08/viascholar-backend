import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({
    example:
      'Yes, you can upload both pages together in the document uploader and the system will stitch them into a single PDF automatically!',
    description: 'Comment or answer text',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  content!: string;
}
