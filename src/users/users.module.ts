import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { CoordinatorDashboardService } from './services/coordinator-dashboard.service.js';
import { GrantorDashboardService } from './services/grantor-dashboard.service.js';
import { SidebarBadgesService } from './services/sidebar-badges.service.js';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    AdminDashboardService,
    CoordinatorDashboardService,
    GrantorDashboardService,
    SidebarBadgesService,
  ],
  exports: [
    UsersService,
    AdminDashboardService,
    CoordinatorDashboardService,
    GrantorDashboardService,
    SidebarBadgesService,
  ],
})
export class UsersModule {}
