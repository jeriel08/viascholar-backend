import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { CreatePostDto } from './dto/create-post.dto.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { QueryPostsDto } from './dto/query-posts.dto.js';
import { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class ForumService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Create a new forum discussion or question
  async createPost(authorUserId: number, dto: CreatePostDto) {
    const post = await this.prisma.forumPost.create({
      data: {
        author_user_id: authorUserId,
        title: dto.title,
        content: dto.content,
        category: (dto.category || 'GENERAL').toUpperCase(),
      },
      include: {
        author: {
          include: { scholar_profile: true, employee: true },
        },
      },
    });

    const authorProfile = post.author.scholar_profile || post.author.employee;
    const authorName =
      `${authorProfile?.first_name || ''} ${authorProfile?.last_name || ''}`.trim() ||
      'User';

    const postPayload = {
      post_id: post.post_id,
      title: post.title,
      content: post.content,
      category: post.category,
      is_pinned: post.is_pinned,
      views_count: post.views_count,
      author: {
        user_id: post.author.user_id,
        name: authorName,
        first_name: authorProfile?.first_name || '',
        last_name: authorProfile?.last_name || '',
        email: post.author.email,
        role: post.author.role,
        avatar_url: authorProfile?.avatar_url || null,
      },
      comments_count: 0,
      created_at: post.created_at,
    };

    // Real-time broadcast to all online scholars and staff
    this.eventsGateway.emitToAll('forum:new_post', postPayload);

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

    const [total, posts] = await Promise.all([
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
    ]);

    const formattedPosts = posts.map((p) => {
      const authorProfile = p.author.scholar_profile || p.author.employee;
      const authorName =
        `${authorProfile?.first_name || ''} ${authorProfile?.last_name || ''}`.trim() ||
        'User';

      return {
        post_id: p.post_id,
        title: p.title,
        content: p.content,
        category: p.category,
        is_pinned: p.is_pinned,
        views_count: p.views_count,
        comments_count: p._count.comments,
        author: {
          user_id: p.author.user_id,
          name: authorName,
          first_name: authorProfile?.first_name || '',
          last_name: authorProfile?.last_name || '',
          email: p.author.email,
          role: p.author.role,
          avatar_url: authorProfile?.avatar_url || null,
        },
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
    const updatedPost = await this.prisma.forumPost.update({
      where: { post_id: postId },
      data: { views_count: { increment: 1 } },
      select: { views_count: true },
    });

    const authorProfile = post.author.scholar_profile || post.author.employee;
    const authorName =
      `${authorProfile?.first_name || ''} ${authorProfile?.last_name || ''}`.trim() ||
      'User';

    const formattedComments = post.comments.map((c) => {
      const cProfile = c.author.scholar_profile || c.author.employee;
      const cAuthorName =
        `${cProfile?.first_name || ''} ${cProfile?.last_name || ''}`.trim() ||
        'User';

      return {
        comment_id: c.comment_id,
        content: c.content,
        created_at: c.created_at,
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
      title: post.title,
      content: post.content,
      category: post.category,
      is_pinned: post.is_pinned,
      views_count: updatedPost.views_count,
      author: {
        user_id: post.author.user_id,
        name: authorName,
        first_name: authorProfile?.first_name || '',
        last_name: authorProfile?.last_name || '',
        email: post.author.email,
        role: post.author.role,
        avatar_url: authorProfile?.avatar_url || null,
      },
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
      content: comment.content,
      created_at: comment.created_at,
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
    }

    return commentPayload;
  }

  // 5. Delete a post (Author or Staff only)
  async deletePost(userId: number, postId: number, userRole: string) {
    const post = await this.prisma.forumPost.findUnique({
      where: { post_id: postId },
    });

    if (!post) {
      throw new NotFoundException(`Forum post ID ${postId} not found.`);
    }

    const staffRoles = ['ADMIN', 'COORDINATOR', 'GRANTOR'];
    const isStaff = staffRoles.includes(userRole);
    const isAuthor = post.author_user_id === userId;

    if (!isAuthor && !isStaff) {
      throw new ForbiddenException(
        'You do not have permission to delete this post.',
      );
    }

    await this.prisma.forumPost.delete({
      where: { post_id: postId },
    });

    this.eventsGateway.emitToAll('forum:post_deleted', { postId });

    return { message: 'Forum post deleted successfully.', post_id: postId };
  }

  // 6. Delete a comment (Author or Staff only)
  async deleteComment(userId: number, commentId: number, userRole: string) {
    const comment = await this.prisma.forumComment.findUnique({
      where: { comment_id: commentId },
    });

    if (!comment) {
      throw new NotFoundException(`Comment ID ${commentId} not found.`);
    }

    const staffRoles = ['ADMIN', 'COORDINATOR', 'GRANTOR'];
    const isStaff = staffRoles.includes(userRole);
    const isAuthor = comment.author_user_id === userId;

    if (!isAuthor && !isStaff) {
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
