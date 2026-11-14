import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdatePostDto {
  @ApiPropertyOptional({
    example: 'How do I submit my Form 138 if grades are on separate sheets?',
    description: 'Updated title of the forum discussion',
  })
  @IsString()
  @IsOptional()
  @MinLength(3)
  title?: string;

  @ApiPropertyOptional({
    example:
      'Updated details about combining high school grade cards into one PDF before uploading.',
    description: 'Updated body content of the forum discussion',
  })
  @IsString()
  @IsOptional()
  @MinLength(5)
  content?: string;

  @ApiPropertyOptional({
    example: 'ACADEMIC',
    description:
      'Category tag (e.g. ACADEMIC, STIPENDS, GENERAL, ANNOUNCEMENT)',
  })
  @IsString()
  @IsOptional()
  category?: string;
}
