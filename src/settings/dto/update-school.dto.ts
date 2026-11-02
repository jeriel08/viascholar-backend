import { PartialType } from '@nestjs/swagger';
import { CreateSchoolDto } from './create-school.dto.js';

export class UpdateSchoolDto extends PartialType(CreateSchoolDto) {}

