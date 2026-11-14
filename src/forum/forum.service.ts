import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { CreatePostDto } from './dto/create-post.dto.js';
import { UpdatePostDto } from './dto/update-post.dto.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { QueryPostsDto } from './dto/query-posts.dto.js';
import { Prisma, Role } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  USER_SETTINGS_AUDIT_ACTION,
  parseUserSettings,
} from '../auth/user-settings.util.js';

export interface ForumTaggedUser {
  user_id: number;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  title: string | null;
  avatar_url: string | null;
}

@Injectable()
export class ForumService {
  private static readonly TAG_MARKER_REGEX =
    /\n?<!--\s*forum-tags:\[([0-9,\s]*)\]\s*-->$/;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  private parseContentAndTagIds(rawContent: string): {
    cleanContent: string;
    tagIds: number[];
  } {
    const content = typeof rawContent === 'string' ? rawContent : '';
    const match = ForumService.TAG_MARKER_REGEX.exec(content);
    if (!match) {
      return { cleanContent: content, tagIds: [] };
    }

    const cleanContent = content.slice(0, match.index);
    const tagIds = Array.from(
      new Set(
        match[1]
          .split(',')
          .map((part) => Number.parseInt(part.trim(), 10))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    );

    return { cleanContent, tagIds };
  }

  private buildStoredContent(cleanContent: string, tagIds: number[]): string {
    const stripped = this.parseContentAndTagIds(cleanContent).cleanContent;
    const uniqueIds = Array.from(
      new Set(tagIds.filter((id) => Number.isInteger(id) && id > 0)),
    );
    if (uniqueIds.length === 0) {
      return stripped;
    }
    return `${stripped}\n<!-- forum-tags:[${uniqueIds.join(',')}] -->`;
  }

  async getTaggableStaff(excludeUserId?: number): Promise<ForumTaggedUser[]> {
    const staff = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.COORDINATOR, Role.GRANTOR] },
        is_active: true,
        ...(excludeUserId ? { user_id: { not: excludeUserId } } : {}),
      },
      include: { employee: true },
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
    });

    return staff
      .filter((user) => user.user_id !== excludeUserId)
      .map((user) => {
        const firstName = user.employee?.first_name?.trim() || '';
        const lastName = user.employee?.last_name?.trim() || '';
        const fullName =
          `${firstName} ${lastName}`.trim() ||
          user.email?.split('@')[0] ||
          'Staff';

        return {
          user_id: user.user_id,
          name: fullName,
          first_name: firstName,
          last_name: lastName,
          email: user.email,
          role: user.role,
          title: user.employee?.title || null,
          avatar_url: user.employee?.avatar_url || null,
        };
      });
  }

  private resolveTaggedUsers(
    cleanContent: string,
    explicitTagIds: number[],
    staffList: ForumTaggedUser[],
    excludeUserId?: number,
  ): ForumTaggedUser[] {
    if (!staffList.length) return [];

    const idSet = new Set(
      explicitTagIds.filter(
        (id) => Number.isInteger(id) && id > 0 && id !== excludeUserId,
      ),
    );
    const normalizedContent = cleanContent.toLowerCase();

    return staffList.filter((staff) => {
      if (staff.user_id === excludeUserId) return false;
      if (idSet.has(staff.user_id)) return true;
      if (staff.name) {
        const mentionToken = `@${staff.name.toLowerCase()}`;
        if (normalizedContent.includes(mentionToken)) {
          return true;
        }
      }
      return false;
    });
  }

  private async notifyTaggedStaff(
    authorUserId: number,
    authorName: string,
    postId: number,
    postTitle: string,
    taggedStaff: ForumTaggedUser[],
  ) {
    for (const staff of taggedStaff) {
      if (staff.user_id === authorUserId) continue;

      this.eventsGateway.emitToUser(staff.user_id, 'forum:post_tagged', {
        post_id: postId,
        title: postTitle,
        tagged_by: authorName,
      });

      const link =
        staff.role === Role.COORDINATOR ? '/CoordinatorForum' : '/grantForum';

      try {
        await Promise.resolve(
          this.notificationsService.notifyUser(staff.user_id, {
            title: 'Tagged in Forum Post',
            message: `${authorName} tagged you in "${postTitle}".`,
            category: 'forum',
            link,
          }),
        );
      } catch {
        // Notification failure should not break forum post creation or updates
      }
    }
  }

  private async getPublicProfileMap(
    userIds: number[],
  ): Promise<Map<number, boolean>> {
    const uniqueIds = Array.from(new Set(userIds));
    const map = new Map<number, boolean>();
    if (
      uniqueIds.length === 0 ||
      typeof this.prisma.auditLog?.findMany !== 'function'
    ) {
      return map;
    }

    const logs = await this.prisma.auditLog.findMany({
      where: {
        user_id: { in: uniqueIds },
        action: USER_SETTINGS_AUDIT_ACTION,
      },
      orderBy: { created_at: 'desc' },
      select: {
        user_id: true,
        details: true,
      },
    });

    for (const log of logs) {
      if (log.user_id !== null && !map.has(log.user_id)) {
        map.set(log.user_id, parseUserSettings(log.details).publicProfile);
      }
    }

    return map;
  }

  private formatAuthor(
    user: {
      user_id: number;
      email: string;
      role: Role;
      scholar_profile?: {
        first_name: string;
        last_name: string;
        avatar_url?: string | null;
        bio?: string | null;
      } | null;
      employee?: {
        first_name: string;
        last_name: string;
        avatar_url?: string | null;
        bio?: string | null;
      } | null;
    },
    isPublicProfile: boolean,
    activityCounts?: {
      postsCount: number;
      commentsCount: number;
    },
  ) {
    const authorProfile = user.scholar_profile || user.employee;
    const authorName =
      `${authorProfile?.first_name || ''} ${authorProfile?.last_name || ''}`.trim() ||
      'User';

    return {
      user_id: user.user_id,
      name: authorName,
      first_name: authorProfile?.first_name || '',
      last_name: authorProfile?.last_name || '',
      email: isPublicProfile ? user.email : null,
      role: user.role,
      avatar_url: authorProfile?.avatar_url || null,
      bio: isPublicProfile ? authorProfile?.bio || null : null,
      public_profile: isPublicProfile,
      ...(activityCounts
        ? {
            forum_posts_count: isPublicProfile
              ? activityCounts.postsCount
              : null,
            forum_comments_count: isPublicProfile
              ? activityCounts.commentsCount
              : null,
          }
        : {}),
    };
  }

  // 1. Create a new forum discussion or question
  async createPost(authorUserId: number, dto: CreatePostDto) {
    const staffList = await this.getTaggableStaff(authorUserId);
    const parsedInput = this.parseContentAndTagIds(dto.content);
    const resolvedStaff = this.resolveTaggedUsers(
      parsedInput.cleanContent,
      [...parsedInput.tagIds, ...(dto.tagged_user_ids || [])],
      staffList,
      authorUserId,
    );
    const taggedUserIds = resolvedStaff.map((s) => s.user_id);
    const storedContent = this.buildStoredContent(
      parsedInput.cleanContent,
      taggedUserIds,
    );

    const post = await this.prisma.forumPost.create({
      data: {
        author_user_id: authorUserId,
        title: dto.title,
        content: storedContent,
        category: (dto.category || 'GENERAL').toUpperCase(),
      },
      include: {
        author: {
          include: { scholar_profile: true, employee: true },
        },
      },
    });

    const publicProfileMap = await this.getPublicProfileMap([
      post.author.user_id,
    ]);
    const isPublicProfile = publicProfileMap.get(post.author.user_id) ?? true;
    const formattedAuthor = this.formatAuthor(post.author, isPublicProfile);
    const authorName = formattedAuthor.name;

    const { cleanContent } = this.parseContentAndTagIds(post.content);

    const postPayload = {
      post_id: post.post_id,
      author_user_id: post.author_user_id,
      title: post.title,
      content: cleanContent,
      category: post.category,
      is_pinned: post.is_pinned,
      views_count: post.views_count,
      tagged_user_ids: taggedUserIds,
      tagged_users: resolvedStaff,
      author: formattedAuthor,
      comments_count: 0,
      created_at: post.created_at,
      updated_at: post.updated_at,
    };

    // Real-time broadcast to all online scholars and staff
    this.eventsGateway.emitToAll('forum:new_post', postPayload);

    await this.notifyTaggedStaff(
      authorUserId,
      authorName,
      post.post_id,
      post.title,
      resolvedStaff,
    );

    return postPayload;
  }

  // 2. Retrieve a paginated list of forum posts with search and category filters
  async getPosts(query: QueryPostsDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ForumPostWhereInput = {};

    if (query.category) {
      where.category = query.category.toUpperCase();
    }

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { content: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [total, posts, staffList] = await Promise.all([
      this.prisma.forumPost.count({ where }),
      this.prisma.forumPost.findMany({
        where,
        orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }],
        skip,
        take: limit,
        include: {
          author: {
            include: { scholar_profile: true, employee: true },
          },
          _count: {
            select: { comments: true },
          },
        },
      }),
      this.getTaggableStaff(),
    ]);

    const publicProfileMap = await this.getPublicProfileMap(
      posts.map((p) => p.author.user_id),
    );
    const formattedPosts = posts.map((p) => {
      const isPublicProfile = publicProfileMap.get(p.author.user_id) ?? true;
      const parsed = this.parseContentAndTagIds(p.content);
      const taggedUsers = this.resolveTaggedUsers(
        parsed.cleanContent,
        parsed.tagIds,
        staffList,
        p.author_user_id,
      );

      return {
        post_id: p.post_id,
        author_user_id: p.author_user_id,
        title: p.title,
        content: parsed.cleanContent,
        category: p.category,
        is_pinned: p.is_pinned,
        views_count: p.views_count,
        comments_count: p._count.comments,
        tagged_user_ids: taggedUsers.map((s) => s.user_id),
        tagged_users: taggedUsers,
        author: this.formatAuthor(p.author, isPublicProfile),
        created_at: p.created_at,
        updated_at: p.updated_at,
      };
    });

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      posts: formattedPosts,
    };
  }

  // 3. View a single post with comments and increment view count
  async getPostById(postId: number) {
    const post = await this.prisma.forumPost.findUnique({
      where: { post_id: postId },
      include: {
        author: {
          include: { scholar_profile: true, employee: true },
        },
        comments: {
          orderBy: { created_at: 'asc' },
          include: {
            author: {
              include: { scholar_profile: true, employee: true },
            },
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundException(`Forum post ID ${postId} not found.`);
    }

    // Increment view count
    const [updatedPost, staffList] = await Promise.all([
      this.prisma.forumPost.update({
        where: { post_id: postId },
        data: { views_count: { increment: 1 } },
        select: { views_count: true },
      }),
      this.getTaggableStaff(),
    ]);

    const publicProfileMap = await this.getPublicProfileMap([
      post.author.user_id,
    ]);
    const isPublicProfile = publicProfileMap.get(post.author.user_id) ?? true;

    let activityCounts = { postsCount: 0, commentsCount: 0 };
    if (
      isPublicProfile &&
      typeof this.prisma.forumPost?.count === 'function' &&
      typeof this.prisma.forumComment?.count === 'function'
    ) {
      const [postsCount, commentsCount] = await Promise.all([
        this.prisma.forumPost.count({
          where: { author_user_id: post.author.user_id },
        }),
        this.prisma.forumComment.count({
          where: { author_user_id: post.author.user_id },
        }),
      ]);
      activityCounts = { postsCount, commentsCount };
    }

    const formattedAuthor = this.formatAuthor(
      post.author,
      isPublicProfile,
      activityCounts,
    );

    const parsed = this.parseContentAndTagIds(post.content);
    const taggedUsers = this.resolveTaggedUsers(
      parsed.cleanContent,
      parsed.tagIds,
      staffList,
      post.author_user_id,
    );

    const formattedComments = post.comments.map((c) => {
      const cProfile = c.author.scholar_profile || c.author.employee;
      const cAuthorName =
        `${cProfile?.first_name || ''} ${cProfile?.last_name || ''}`.trim() ||
        'User';

      return {
        comment_id: c.comment_id,
        post_id: c.post_id ?? post.post_id,
        author_user_id: c.author_user_id ?? c.author.user_id,
        content: c.content,
        created_at: c.created_at,
        updated_at: c.updated_at,
        author: {
          user_id: c.author.user_id,
          name: cAuthorName,
          first_name: cProfile?.first_name || '',
          last_name: cProfile?.last_name || '',
          email: c.author.email,
          role: c.author.role,
          avatar_url: cProfile?.avatar_url || null,
        },
      };
    });

    return {
      post_id: post.post_id,
      author_user_id: post.author_user_id,
      title: post.title,
      content: parsed.cleanContent,
      category: post.category,
      is_pinned: post.is_pinned,
      views_count: updatedPost.views_count,
      tagged_user_ids: taggedUsers.map((s) => s.user_id),
      tagged_users: taggedUsers,
      author: formattedAuthor,
      created_at: post.created_at,
      updated_at: post.updated_at,
      comments: formattedComments,
    };
  }

  // 4. Add a comment to an existing forum post
  async addComment(
    authorUserId: number,
    postId: number,
    dto: CreateCommentDto,
  ) {
    const post = await this.prisma.forumPost.findUnique({
      where: { post_id: postId },
    });

    if (!post) {
      throw new NotFoundException(`Forum post ID ${postId} not found.`);
    }

    const comment = await this.prisma.forumComment.create({
      data: {
        post_id: postId,
        author_user_id: authorUserId,
        content: dto.content,
      },
      include: {
        author: {
          include: { scholar_profile: true, employee: true },
        },
      },
    });

    const cProfile = comment.author.scholar_profile || comment.author.employee;
    const cAuthorName =
      `${cProfile?.first_name || ''} ${cProfile?.last_name || ''}`.trim() ||
      'User';

    const commentPayload = {
      comment_id: comment.comment_id,
      post_id: postId,
      author_user_id: comment.author_user_id,
      content: comment.content,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      author: {
        user_id: comment.author.user_id,
        name: cAuthorName,
        first_name: cProfile?.first_name || '',
        last_name: cProfile?.last_name || '',
        email: comment.author.email,
        role: comment.author.role,
        avatar_url: cProfile?.avatar_url || null,
      },
    };

    // Real-time broadcast to viewers of the thread
    this.eventsGateway.emitToRoom(
      `forum_post_${postId}`,
      'forum:new_comment',
      commentPayload,
    );

    // If author of comment is not the post author, notify post author directly
    if (post.author_user_id !== authorUserId) {
      this.eventsGateway.emitToUser(
        post.author_user_id,
        'forum:comment_notification',
        {
          postId,
          postTitle: post.title,
          comment: commentPayload,
        },
      );

      void this.notificationsService.notifyUser(post.author_user_id, {
        title: 'Forum Discussion Reply',
        message: `${cProfile?.first_name || 'Someone'} replied to "${post.title}".`,
        category: 'forum',
        link: '/SchoForum',
      });
    }

    return commentPayload;
  }

  // 5. Edit a post (Post author only)
  async updatePost(userId: number, postId: number, dto: UpdatePostDto) {
    const post = await this.prisma.forumPost.findUnique({
      where: { post_id: postId },
    });

    if (!post) {
      throw new NotFoundException(`Forum post ID ${postId} not found.`);
    }

    if (post.author_user_id !== userId) {
      throw new ForbiddenException(
        'You do not have permission to edit this post.',
      );
    }

    const staffList = await this.getTaggableStaff(userId);
    const existingParsed = this.parseContentAndTagIds(post.content);
    const previousResolved = this.resolveTaggedUsers(
      existingParsed.cleanContent,
      existingParsed.tagIds,
      staffList,
      userId,
    );
    const previousIdSet = new Set(previousResolved.map((s) => s.user_id));

    const nextCleanContent =
      dto.content !== undefined
        ? this.parseContentAndTagIds(dto.content.trim()).cleanContent
        : existingParsed.cleanContent;
    const nextExplicitIds =
      dto.tagged_user_ids !== undefined
        ? dto.tagged_user_ids
        : existingParsed.tagIds;

    const resolvedStaff = this.resolveTaggedUsers(
      nextCleanContent,
      nextExplicitIds,
      staffList,
      userId,
    );
    const taggedUserIds = resolvedStaff.map((s) => s.user_id);

    const data: Prisma.ForumPostUpdateInput = {};
    if (dto.title !== undefined) {
      data.title = dto.title.trim();
    }
    if (dto.content !== undefined || dto.tagged_user_ids !== undefined) {
      data.content = this.buildStoredContent(nextCleanContent, taggedUserIds);
    }
    if (dto.category !== undefined) {
      data.category = dto.category.trim().toUpperCase();
    }

    const updated = await this.prisma.forumPost.update({
      where: { post_id: postId },
      data,
      include: {
        author: {
          include: { scholar_profile: true, employee: true },
        },
        _count: {
          select: { comments: true },
        },
      },
    });

    const authorProfile =
      updated.author.scholar_profile || updated.author.employee;
    const authorName =
      `${authorProfile?.first_name || ''} ${authorProfile?.last_name || ''}`.trim() ||
      'User';

    const { cleanContent } = this.parseContentAndTagIds(updated.content);

    const postPayload = {
      post_id: updated.post_id,
      author_user_id: updated.author_user_id,
      title: updated.title,
      content: cleanContent,
      category: updated.category,
      is_pinned: updated.is_pinned,
      views_count: updated.views_count,
      comments_count: updated._count.comments,
      tagged_user_ids: taggedUserIds,
      tagged_users: resolvedStaff,
      author: {
        user_id: updated.author.user_id,
        name: authorName,
        first_name: authorProfile?.first_name || '',
        last_name: authorProfile?.last_name || '',
        email: updated.author.email,
        role: updated.author.role,
        avatar_url: authorProfile?.avatar_url || null,
      },
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    };

    this.eventsGateway.emitToAll('forum:post_updated', postPayload);

    const newlyTagged = resolvedStaff.filter(
      (s) => !previousIdSet.has(s.user_id),
    );
    await this.notifyTaggedStaff(
      userId,
      authorName,
      updated.post_id,
      updated.title,
      newlyTagged,
    );

    return postPayload;
  }

  // 6. Delete a post and all of its comments (Post author only)
  async deletePost(userId: number, postId: number) {
    const post = await this.prisma.forumPost.findUnique({
      where: { post_id: postId },
    });

    if (!post) {
      throw new NotFoundException(`Forum post ID ${postId} not found.`);
    }

    if (post.author_user_id !== userId) {
      throw new ForbiddenException(
        'You do not have permission to delete this post.',
      );
    }

    await this.prisma.forumComment.deleteMany({
      where: { post_id: postId },
    });

    await this.prisma.forumPost.delete({
      where: { post_id: postId },
    });

    this.eventsGateway.emitToAll('forum:post_deleted', { postId });

    return { message: 'Forum post deleted successfully.', post_id: postId };
  }

  // 7. Edit a comment (Comment author only)
  async updateComment(
    userId: number,
    commentId: number,
    dto: UpdateCommentDto,
  ) {
    const comment = await this.prisma.forumComment.findUnique({
      where: { comment_id: commentId },
    });

    if (!comment) {
      throw new NotFoundException(`Comment ID ${commentId} not found.`);
    }

    if (comment.author_user_id !== userId) {
      throw new ForbiddenException(
        'You do not have permission to edit this comment.',
      );
    }

    const updated = await this.prisma.forumComment.update({
      where: { comment_id: commentId },
      data: { content: dto.content.trim() },
      include: {
        author: {
          include: { scholar_profile: true, employee: true },
        },
      },
    });

    const cProfile = updated.author.scholar_profile || updated.author.employee;
    const cAuthorName =
      `${cProfile?.first_name || ''} ${cProfile?.last_name || ''}`.trim() ||
      'User';

    const commentPayload = {
      comment_id: updated.comment_id,
      post_id: updated.post_id,
      author_user_id: updated.author_user_id,
      content: updated.content,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      author: {
        user_id: updated.author.user_id,
        name: cAuthorName,
        first_name: cProfile?.first_name || '',
        last_name: cProfile?.last_name || '',
        email: updated.author.email,
        role: updated.author.role,
        avatar_url: cProfile?.avatar_url || null,
      },
    };

    this.eventsGateway.emitToRoom(
      `forum_post_${updated.post_id}`,
      'forum:comment_updated',
      commentPayload,
    );

    return commentPayload;
  }

  // 8. Delete a comment (Comment author only)
  async deleteComment(userId: number, commentId: number) {
    const comment = await this.prisma.forumComment.findUnique({
      where: { comment_id: commentId },
    });

    if (!comment) {
      throw new NotFoundException(`Comment ID ${commentId} not found.`);
    }

    if (comment.author_user_id !== userId) {
      throw new ForbiddenException(
        'You do not have permission to delete this comment.',
      );
    }

    await this.prisma.forumComment.delete({
      where: { comment_id: commentId },
    });

    this.eventsGateway.emitToRoom(
      `forum_post_${comment.post_id}`,
      'forum:comment_deleted',
      { commentId, postId: comment.post_id },
    );

    return { message: 'Comment deleted successfully.', comment_id: commentId };
  }

  // 7. Toggle pinned status (Staff only)
  async togglePin(postId: number) {
    const post = await this.prisma.forumPost.findUnique({
      where: { post_id: postId },
    });

    if (!post) {
      throw new NotFoundException(`Forum post ID ${postId} not found.`);
    }

    const updated = await this.prisma.forumPost.update({
      where: { post_id: postId },
      data: { is_pinned: !post.is_pinned },
    });

    this.eventsGateway.emitToAll('forum:post_updated', {
      postId: updated.post_id,
      is_pinned: updated.is_pinned,
    });

    return updated;
  }
}
