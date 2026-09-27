import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service.js';
import { QueryNotificationsDto } from './dto/query-notifications.dto.js';

interface RequestWithUser {
  user: {
    user_id: number;
    email: string;
    role: string;
  };
}

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user notifications and unread count' })
  getUserNotifications(
    @Request() req: RequestWithUser,
    @Query() query: QueryNotificationsDto,
  ) {
    return this.notificationsService.getUserNotifications(
      req.user.user_id,
      query,
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get current user unread notification count' })
  async getUnreadCount(@Request() req: RequestWithUser) {
    const unreadCount = await this.notificationsService.getUnreadCount(
      req.user.user_id,
    );
    return { unreadCount };
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read for current user' })
  markAllAsRead(@Request() req: RequestWithUser) {
    return this.notificationsService.markAllAsRead(req.user.user_id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a specific notification as read' })
  markAsRead(
    @Request() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.notificationsService.markAsRead(req.user.user_id, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a single notification' })
  deleteNotification(
    @Request() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.notificationsService.deleteNotification(req.user.user_id, id);
  }

  @Delete()
  @ApiOperation({ summary: 'Clear all notifications for current user' })
  clearAll(@Request() req: RequestWithUser) {
    return this.notificationsService.clearAll(req.user.user_id);
  }
}
