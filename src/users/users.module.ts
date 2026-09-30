import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { CoordinatorDashboardService } from './services/coordinator-dashboard.service.js';
import { GrantorDashboardService } from './services/grantor-dashboard.service.js';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    AdminDashboardService,
    CoordinatorDashboardService,
    GrantorDashboardService,
  ],
  exports: [
    UsersService,
    AdminDashboardService,
    CoordinatorDashboardService,
    GrantorDashboardService,
  ],
})
export class UsersModule {}
