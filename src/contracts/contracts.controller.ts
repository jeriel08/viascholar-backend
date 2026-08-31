import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { ContractsService } from './contracts.service.js';
import { CreateContractDto } from './dto/create-contract.dto.js';
import { QueryContractsDto } from './dto/query-contracts.dto.js';

@ApiTags('Scholarship Contracts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Post()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Create a pending contract for an approved scholar (Staff only)',
  })
  create(@Request() req, @Body() dto: CreateContractDto) {
    return this.contractsService.createContract(req.user.user_id, dto);
  }

  @Get('me')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({ summary: 'List own scholarship contracts' })
  getMyContracts(@Request() req) {
    return this.contractsService.getMyContracts(req.user.user_id);
  }

  @Get()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'List all contracts with optional status filter (Staff only)',
  })
  findAll(@Query() query: QueryContractsDto) {
    return this.contractsService.findAll(query.status);
  }

  @Patch(':id/sign')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({ summary: 'Sign your own pending scholarship contract' })
  sign(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.contractsService.signContract(req.user.user_id, id);
  }
}
