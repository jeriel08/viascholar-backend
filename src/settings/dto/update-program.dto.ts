import { PartialType } from '@nestjs/swagger';
import { CreateAcademicProgramDto } from './create-program.dto.js';

export class UpdateAcademicProgramDto extends PartialType(CreateAcademicProgramDto) {}

