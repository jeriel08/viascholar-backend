import {
  Body,
  Controller,
  Delete,
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
import { ForumService } from './forum.service.js';
import { CreatePostDto } from './dto/create-post.dto.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { QueryPostsDto } from './dto/query-posts.dto.js';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/client.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    role: string;
    [key: string]: unknown;
  };
}

@ApiTags('Community Forum')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('forum')
export class ForumController {
  constructor(private readonly forumService: ForumService) {}

  @Post('posts')
  @ApiOperation({
    summary: 'Create a new discussion post or inquiry in the community forum',
  })
  createPost(@Request() req: AuthenticatedRequest, @Body() dto: CreatePostDto) {
    return this.forumService.createPost(req.user.user_id, dto);
  }

  @Get('posts')
  @ApiOperation({
    summary:
      'Retrieve paginated list of forum posts with category and search filtering',
  })
  getPosts(@Query() query: QueryPostsDto) {
    return this.forumService.getPosts(query);
  }

  @Get('posts/:id')
  @ApiOperation({
    summary: 'Get details of a forum post, its comments, and increment views',
  })
  getPostById(@Param('id', ParseIntPipe) id: number) {
    return this.forumService.getPostById(id);
  }

  @Post('posts/:id/comments')
  @ApiOperation({
    summary: 'Post a comment/reply to an existing forum discussion',
  })
  addComment(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateCommentDto,
  ) {
    return this.forumService.addComment(req.user.user_id, id, dto);
  }

  @Delete('posts/:id')
  @ApiOperation({
    summary: 'Delete a forum post (post author or staff members only)',
  })
  deletePost(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.forumService.deletePost(req.user.user_id, id, req.user.role);
  }

  @Delete('comments/:id')
  @ApiOperation({
    summary: 'Delete a forum comment (comment author or staff members only)',
  })
  deleteComment(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.forumService.deleteComment(req.user.user_id, id, req.user.role);
  }

  @Patch('posts/:id/pin')
  @Roles(Role.ADMIN, Role.COORDINATOR, Role.GRANTOR)
  @ApiOperation({
    summary: 'Toggle pinned state for a forum post (Staff only)',
  })
  togglePin(@Param('id', ParseIntPipe) id: number) {
    return this.forumService.togglePin(id);
  }
}
