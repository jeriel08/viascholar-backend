import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreatePostDto {
  @ApiProperty({
    example:
      'How do I submit my Form 138 if the grades are on separate sheets?',
    description: 'Title of the forum question or discussion topic',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  title!: string;

  @ApiProperty({
    example:
      'My high school provided two separate cards for the first and second semester. Should I combine them into one PDF before uploading?',
    description: 'Detailed description or question text',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  content!: string;

  @ApiPropertyOptional({
    example: 'ACADEMIC',
    default: 'GENERAL',
    description:
      'Category tag (e.g. ACADEMIC, STIPENDS, GENERAL, ANNOUNCEMENT)',
  })
  @IsString()
  @IsOptional()
  category?: string = 'GENERAL';
}
