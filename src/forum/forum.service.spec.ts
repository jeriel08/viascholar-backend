import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ForumService } from './forum.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { CreatePostDto } from './dto/create-post.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringContaining = (substr: string) =>
  expect.stringContaining(substr) as string;

const createPrismaMock = () => ({
  user: {
    findMany: vi.fn(),
  },
  forumPost: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  forumComment: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
});

const createEventsMock = () => ({
  emitToAll: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
});

const createNotificationsMock = () => ({
  notifyUser: vi.fn(),
});

const makeAuthor = (overrides: Record<string, unknown> = {}) => ({
  user_id: 7,
  email: 'scholar@example.com',
  role: 'SCHOLAR',
  scholar_profile: {
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    avatar_url: 'https://cdn.test/avatar.png',
  },
  employee: null,
  ...overrides,
});

const makePost = (overrides: Record<string, unknown> = {}) => ({
  post_id: 55,
  author_user_id: 7,
  title: 'How do I submit Form 138?',
  content: 'Please help me with my submission.',
  category: 'ACADEMIC',
  is_pinned: false,
  views_count: 10,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-02T00:00:00.000Z'),
  author: makeAuthor(),
  _count: { comments: 1 },
  ...overrides,
});

const makeComment = (overrides: Record<string, unknown> = {}) => ({
  comment_id: 99,
  post_id: 55,
  author_user_id: 8,
  content: 'Combine them into one PDF.',
  created_at: new Date('2026-08-02T01:00:00.000Z'),
  author: makeAuthor({
    user_id: 8,
    email: 'staff@example.com',
    role: 'COORDINATOR',
    scholar_profile: null,
    employee: {
      first_name: 'Maria',
      last_name: 'Santos',
      avatar_url: null,
    },
  }),
  ...overrides,
});

const postDto = {
  title: 'How do I submit Form 138?',
  content: 'Please help me with my submission.',
  category: 'ACADEMIC',
} as CreatePostDto;

const commentDto = {
  content: 'Combine them into one PDF.',
};

describe('ForumService', () => {
  let service: ForumService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.user.findMany.mockResolvedValue([]);
    prisma.forumPost.create.mockResolvedValue(makePost());
    prisma.forumPost.findUnique.mockResolvedValue(makePost());
    prisma.forumPost.findMany.mockResolvedValue([makePost()]);
    prisma.forumPost.count.mockResolvedValue(1);
    prisma.forumPost.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makePost({ ...data })),
    );
    prisma.forumPost.delete.mockResolvedValue(makePost());
    prisma.forumComment.create.mockResolvedValue(makeComment());
    prisma.forumComment.findUnique.mockResolvedValue(makeComment());
    prisma.forumComment.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeComment({ ...data })),
    );
    prisma.forumComment.delete.mockResolvedValue(makeComment());
    prisma.forumComment.deleteMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForumService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<ForumService>(ForumService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('createPost', () => {
    it('normalizes the category and broadcasts to all listeners', async () => {
      const result = await service.createPost(7, {
        ...postDto,
        category: 'academic',
      });

      expect(prisma.forumPost.create).toHaveBeenCalledWith({
        data: {
          author_user_id: 7,
          title: 'How do I submit Form 138?',
          content: 'Please help me with my submission.',
          category: 'ACADEMIC',
        },
        include: anyArg(Object),
      });
      expect(events.emitToAll).toHaveBeenCalledWith(
        'forum:new_post',
        objectMatching({ title: 'How do I submit Form 138?' }),
      );
      expect(result).toEqual(
        objectMatching({
          post_id: 55,
          category: 'ACADEMIC',
          author: objectMatching({
            user_id: 7,
            name: 'Juan Dela Cruz',
          }),
          comments_count: 0,
        }),
      );
    });

    it('falls back to GENERAL when no category is provided', async () => {
      await service.createPost(7, {
        ...postDto,
        category: undefined,
      });

      expect(prisma.forumPost.create).toHaveBeenCalledWith({
        data: objectMatching({ category: 'GENERAL' }),
        include: anyArg(Object),
      });
    });

    it('derives the author name from the employee profile when not a scholar', async () => {
      prisma.forumPost.create.mockResolvedValue(
        makePost({
          author: {
            ...makeAuthor({
              user_id: 2,
              role: 'COORDINATOR',
              scholar_profile: null,
              employee: {
                first_name: 'Maria',
                last_name: 'Santos',
                avatar_url: 'https://cdn.test/staff.png',
              },
            }),
          },
        }),
      );

      const result = await service.createPost(2, postDto);

      expect(result.author).toEqual(
        objectMatching({
          name: 'Maria Santos',
          first_name: 'Maria',
          role: 'COORDINATOR',
          avatar_url: 'https://cdn.test/staff.png',
        }),
      );
    });
  });

  describe('getPosts', () => {
    it('returns paginated results with the configured order and filters', async () => {
      await service.getPosts({
        page: 2,
        limit: 10,
        category: 'academic',
        search: 'Form 138',
      });

      expect(prisma.forumPost.count).toHaveBeenCalledWith({
        where: {
          category: 'ACADEMIC',
          OR: [
            { title: { contains: 'Form 138', mode: 'insensitive' } },
            { content: { contains: 'Form 138', mode: 'insensitive' } },
          ],
        },
      });
      expect(prisma.forumPost.findMany).toHaveBeenCalledWith(
        objectMatching({
          skip: 10,
          take: 10,
          orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }],
        }),
      );
    });

    it('defaults page and limit to 1 and 20 when omitted', async () => {
      const result = await service.getPosts({});

      expect(prisma.forumPost.findMany).toHaveBeenCalledWith(
        objectMatching({ skip: 0, take: 20 }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('computes the total page count from total and limit', async () => {
      prisma.forumPost.count.mockResolvedValue(25);

      const result = await service.getPosts({ limit: 10 });

      expect(result.totalPages).toBe(3);
      expect(result.total).toBe(25);
    });

    it('maps comments_count from the _count shape', async () => {
      const { posts } = await service.getPosts({});

      expect(posts[0].comments_count).toBe(1);
      expect(posts[0].author.name).toBe('Juan Dela Cruz');
    });

    it('keeps the author name placeholder when the profile name is empty', async () => {
      prisma.forumPost.findMany.mockResolvedValue([
        makePost({
          author: makeAuthor({ scholar_profile: null, employee: null }),
        }),
      ]);

      const { posts } = await service.getPosts({});

      expect(posts[0].author.name).toBe('User');
    });
  });

  describe('getPostById', () => {
    it('throws NotFoundException when the post does not exist', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(service.getPostById(999)).rejects.toThrow(
        new NotFoundException('Forum post ID 999 not found.'),
      );
    });

    it('returns the post with incremented views_count and comments', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(
        makePost({
          comments: [
            {
              comment_id: 99,
              content: 'Hello',
              created_at: new Date('2026-08-02T01:00:00.000Z'),
              author: makeAuthor({
                user_id: 8,
                role: 'COORDINATOR',
                scholar_profile: null,
                employee: {
                  first_name: 'Maria',
                  last_name: 'Santos',
                  avatar_url: null,
                },
              }),
            },
          ],
        }),
      );
      prisma.forumPost.update.mockResolvedValue({ views_count: 11 });

      const result = await service.getPostById(55);

      expect(prisma.forumPost.update).toHaveBeenCalledWith(
        objectMatching({
          data: { views_count: { increment: 1 } },
          select: { views_count: true },
        }),
      );
      expect(result.views_count).toBe(11);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].author.name).toBe('Maria Santos');
    });
  });

  describe('addComment', () => {
    it('throws NotFoundException when the post does not exist', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(service.addComment(7, 999, commentDto)).rejects.toThrow(
        new NotFoundException('Forum post ID 999 not found.'),
      );
    });

    it('broadcasts the comment to the thread room', async () => {
      await service.addComment(7, 55, commentDto);

      expect(events.emitToRoom).toHaveBeenCalledWith(
        'forum_post_55',
        'forum:new_comment',
        objectMatching({
          comment_id: 99,
          content: 'Combine them into one PDF.',
        }),
      );
    });

    it('notifies the post author when the commenter is someone else', async () => {
      const result = await service.addComment(8, 55, commentDto);

      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'forum:comment_notification',
        objectMatching({
          postId: 55,
          postTitle: 'How do I submit Form 138?',
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({
          title: 'Forum Discussion Reply',
          message: stringContaining('Maria'),
        }),
      );
      expect(result).toEqual(objectMatching({ comment_id: 99, post_id: 55 }));
    });

    it('does not notify the author when commenting on their own post', async () => {
      await service.addComment(7, 55, commentDto);

      expect(events.emitToUser).not.toHaveBeenCalled();
      expect(notifications.notifyUser).not.toHaveBeenCalled();
    });
  });

  describe('publicProfile privacy', () => {
    const basePost = {
      post_id: 77,
      author_user_id: 7,
      title: 'Privacy Test Post',
      content: 'Testing publicProfile visibility in forum',
      category: 'GENERAL',
      is_pinned: false,
      views_count: 3,
      created_at: new Date('2026-11-14T10:00:00Z'),
      updated_at: new Date('2026-11-14T10:00:00Z'),
      author: {
        user_id: 7,
        email: 'juan@viascholar.ph',
        role: 'SCHOLAR',
        scholar_profile: {
          first_name: 'Juan',
          last_name: 'Dela Cruz',
          avatar_url: 'https://cdn.example/avatar.png',
          bio: 'CS scholar interested in AI',
        },
        employee: null,
      },
    };

    it('masks email, bio, and activity counts in getPosts and getPostById when publicProfile is false', async () => {
      const findManyAudit = vi.fn().mockResolvedValue([
        {
          user_id: 7,
          details: JSON.stringify({ publicProfile: false }),
        },
      ]);
      const commentCount = vi.fn().mockResolvedValue(9);
      const prismaAny = prisma as unknown as Record<string, unknown>;
      prismaAny.auditLog = { findMany: findManyAudit };
      (prisma.forumComment as unknown as Record<string, unknown>).count =
        commentCount;

      prisma.forumPost.count.mockResolvedValueOnce(1);
      prisma.forumPost.findMany.mockResolvedValueOnce([
        { ...basePost, _count: { comments: 2 } },
      ]);
      const listResult = await service.getPosts({ page: 1, limit: 20 });

      expect(listResult.posts[0].author).toEqual(
        objectMatching({
          user_id: 7,
          name: 'Juan Dela Cruz',
          email: null,
          bio: null,
          public_profile: false,
        }),
      );

      prisma.forumPost.findUnique.mockResolvedValueOnce({
        ...basePost,
        comments: [],
      });
      prisma.forumPost.update.mockResolvedValueOnce({ views_count: 4 });
      const detailResult = await service.getPostById(77);

      expect(detailResult.author).toEqual(
        objectMatching({
          user_id: 7,
          name: 'Juan Dela Cruz',
          email: null,
          bio: null,
          public_profile: false,
          forum_posts_count: null,
          forum_comments_count: null,
        }),
      );
      expect(prisma.forumPost.count).toHaveBeenCalledTimes(1);
      expect(commentCount).not.toHaveBeenCalled();

      delete prismaAny.auditLog;
      delete (prisma.forumComment as unknown as Record<string, unknown>).count;
    });

    it('exposes email, bio, and forum activity counts when publicProfile is true', async () => {
      const findManyAudit = vi.fn().mockResolvedValue([
        {
          user_id: 7,
          details: JSON.stringify({ publicProfile: true }),
        },
      ]);
      const commentCount = vi.fn().mockResolvedValue(12);
      const prismaAny = prisma as unknown as Record<string, unknown>;
      prismaAny.auditLog = { findMany: findManyAudit };
      (prisma.forumComment as unknown as Record<string, unknown>).count =
        commentCount;

      prisma.forumPost.count.mockResolvedValueOnce(5);
      prisma.forumPost.findUnique.mockResolvedValueOnce({
        ...basePost,
        comments: [],
      });
      prisma.forumPost.update.mockResolvedValueOnce({ views_count: 4 });

      const detailResult = await service.getPostById(77);

      expect(detailResult.author).toEqual(
        objectMatching({
          user_id: 7,
          name: 'Juan Dela Cruz',
          email: 'juan@viascholar.ph',
          bio: 'CS scholar interested in AI',
          public_profile: true,
          forum_posts_count: 5,
          forum_comments_count: 12,
        }),
      );
      expect(prisma.forumPost.count).toHaveBeenCalledWith({
        where: { author_user_id: 7 },
      });
      expect(commentCount).toHaveBeenCalledWith({
        where: { author_user_id: 7 },
      });

      delete prismaAny.auditLog;
      delete (prisma.forumComment as unknown as Record<string, unknown>).count;
    });

    it('masks email and bio on comment authors when comment author has publicProfile false', async () => {
      const findManyAudit = vi.fn().mockResolvedValue([
        {
          user_id: 9,
          details: JSON.stringify({ publicProfile: false }),
        },
      ]);
      const prismaAny = prisma as unknown as Record<string, unknown>;
      prismaAny.auditLog = { findMany: findManyAudit };

      prisma.forumPost.findUnique.mockResolvedValueOnce({
        ...basePost,
        comments: [
          {
            comment_id: 101,
            post_id: 77,
            author_user_id: 9,
            content: 'Private commenter reply',
            created_at: new Date('2026-11-14T11:00:00Z'),
            author: {
              user_id: 9,
              email: 'private.scholar@viascholar.ph',
              role: 'SCHOLAR',
              scholar_profile: {
                first_name: 'Ana',
                last_name: 'Reyes',
                avatar_url: null,
                bio: 'Secret bio',
              },
              employee: null,
            },
          },
        ],
      });
      prisma.forumPost.update.mockResolvedValueOnce({ views_count: 5 });

      const detailResult = await service.getPostById(77);

      expect(detailResult.comments[0].author).toEqual(
        objectMatching({
          user_id: 9,
          name: 'Ana Reyes',
          email: null,
          bio: null,
          public_profile: false,
        }),
      );

      delete prismaAny.auditLog;
    });
  });

  describe('updatePost', () => {
    it('throws NotFoundException when the post does not exist', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(
        service.updatePost(7, 999, { title: 'Updated Title' }),
      ).rejects.toThrow(new NotFoundException('Forum post ID 999 not found.'));
    });

    it('throws ForbiddenException when caller is not the post owner (including staff)', async () => {
      await expect(
        service.updatePost(99, 55, { title: 'Updated Title' }),
      ).rejects.toThrow(
        new ForbiddenException('You do not have permission to edit this post.'),
      );
      expect(prisma.forumPost.update).not.toHaveBeenCalled();
    });

    it('updates post fields and broadcasts forum:post_updated for the post owner', async () => {
      const result = await service.updatePost(7, 55, {
        title: '  Updated Title  ',
        content: '  Updated content body here  ',
        category: 'stipends',
      });

      expect(prisma.forumPost.update).toHaveBeenCalledWith({
        where: { post_id: 55 },
        data: {
          title: 'Updated Title',
          content: 'Updated content body here',
          category: 'STIPENDS',
        },
        include: anyArg(Object),
      });
      expect(events.emitToAll).toHaveBeenCalledWith(
        'forum:post_updated',
        objectMatching({
          post_id: 55,
          author_user_id: 7,
          title: 'Updated Title',
          content: 'Updated content body here',
          category: 'STIPENDS',
        }),
      );
      expect(result).toEqual(
        objectMatching({
          post_id: 55,
          title: 'Updated Title',
          category: 'STIPENDS',
        }),
      );
    });
  });

  describe('deletePost', () => {
    it('throws NotFoundException when the post does not exist', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(service.deletePost(7, 999)).rejects.toThrow(
        new NotFoundException('Forum post ID 999 not found.'),
      );
    });

    it('throws ForbiddenException when the caller is not the post owner', async () => {
      await expect(service.deletePost(99, 55)).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to delete this post.',
        ),
      );
      expect(prisma.forumComment.deleteMany).not.toHaveBeenCalled();
      expect(prisma.forumPost.delete).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when staff attempts to delete another user post', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(
        makePost({ author_user_id: 7 }),
      );

      await expect(service.deletePost(2, 55)).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to delete this post.',
        ),
      );
      expect(prisma.forumComment.deleteMany).not.toHaveBeenCalled();
      expect(prisma.forumPost.delete).not.toHaveBeenCalled();
    });

    it('allows the post owner to delete all comments and the post', async () => {
      const result = await service.deletePost(7, 55);

      expect(prisma.forumComment.deleteMany).toHaveBeenCalledWith({
        where: { post_id: 55 },
      });
      expect(prisma.forumPost.delete).toHaveBeenCalledWith({
        where: { post_id: 55 },
      });
      expect(events.emitToAll).toHaveBeenCalledWith('forum:post_deleted', {
        postId: 55,
      });
      expect(result).toEqual({
        message: 'Forum post deleted successfully.',
        post_id: 55,
      });
    });
  });

  describe('updateComment', () => {
    it('throws NotFoundException when the comment does not exist', async () => {
      prisma.forumComment.findUnique.mockResolvedValue(null);

      await expect(
        service.updateComment(8, 999, { content: 'Updated reply' }),
      ).rejects.toThrow(new NotFoundException('Comment ID 999 not found.'));
    });

    it('throws ForbiddenException when the post owner tries to edit another user comment', async () => {
      await expect(
        service.updateComment(7, 99, { content: 'Post owner edit attempt' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to edit this comment.',
        ),
      );
      expect(prisma.forumComment.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when another user or staff tries to edit the comment', async () => {
      await expect(
        service.updateComment(2, 99, { content: 'Staff edit attempt' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to edit this comment.',
        ),
      );
      expect(prisma.forumComment.update).not.toHaveBeenCalled();
    });

    it('updates the comment and broadcasts to the thread room for the comment owner', async () => {
      const result = await service.updateComment(8, 99, {
        content: '  Updated helpful advice  ',
      });

      expect(prisma.forumComment.update).toHaveBeenCalledWith({
        where: { comment_id: 99 },
        data: { content: 'Updated helpful advice' },
        include: anyArg(Object),
      });
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'forum_post_55',
        'forum:comment_updated',
        objectMatching({
          comment_id: 99,
          post_id: 55,
          author_user_id: 8,
          content: 'Updated helpful advice',
        }),
      );
      expect(result).toEqual(
        objectMatching({
          comment_id: 99,
          author_user_id: 8,
          content: 'Updated helpful advice',
        }),
      );
    });
  });

  describe('deleteComment', () => {
    it('throws NotFoundException when the comment does not exist', async () => {
      prisma.forumComment.findUnique.mockResolvedValue(null);

      await expect(service.deleteComment(8, 999)).rejects.toThrow(
        new NotFoundException('Comment ID 999 not found.'),
      );
    });

    it('throws ForbiddenException when post owner or another user tries to delete a comment they do not own', async () => {
      await expect(service.deleteComment(7, 99)).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to delete this comment.',
        ),
      );
      await expect(service.deleteComment(2, 99)).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to delete this comment.',
        ),
      );
      expect(prisma.forumComment.delete).not.toHaveBeenCalled();
    });

    it('allows the comment author to delete it and notifies room', async () => {
      const result = await service.deleteComment(8, 99);

      expect(prisma.forumComment.delete).toHaveBeenCalledWith({
        where: { comment_id: 99 },
      });
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'forum_post_55',
        'forum:comment_deleted',
        { commentId: 99, postId: 55 },
      );
      expect(result).toEqual({
        message: 'Comment deleted successfully.',
        comment_id: 99,
      });
    });
  });

  describe('coordinator and grantor tagging', () => {
    const makeStaffRows = () => [
      {
        user_id: 2,
        email: 'coordinator@example.com',
        role: 'COORDINATOR',
        is_active: true,
        employee: {
          first_name: 'Maria',
          last_name: 'Santos',
          title: 'Lead Coordinator',
          avatar_url: null,
        },
      },
      {
        user_id: 5,
        email: 'grantor@example.com',
        role: 'GRANTOR',
        is_active: true,
        employee: {
          first_name: 'Elena',
          last_name: 'Reyes',
          title: 'Foundation Director',
          avatar_url: 'https://cdn.test/elena.png',
        },
      },
    ];

    it('lists active coordinators and grantors via getTaggableStaff', async () => {
      prisma.user.findMany.mockResolvedValue(makeStaffRows());

      const staff = await service.getTaggableStaff();

      expect(staff).toHaveLength(2);
      expect(staff[0]).toEqual({
        user_id: 2,
        name: 'Maria Santos',
        first_name: 'Maria',
        last_name: 'Santos',
        email: 'coordinator@example.com',
        role: 'COORDINATOR',
        title: 'Lead Coordinator',
        avatar_url: null,
      });
      expect(staff[1]).toEqual(
        objectMatching({
          user_id: 5,
          name: 'Elena Reyes',
          role: 'GRANTOR',
        }),
      );
    });

    it('persists tagged coordinators and grantors, strips tag marker in response, and sends notifications on createPost', async () => {
      prisma.user.findMany.mockResolvedValue(makeStaffRows());
      prisma.forumPost.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(
            makePost({
              content: data.content,
            }),
          ),
      );

      const result = await service.createPost(7, {
        ...postDto,
        tagged_user_ids: [2, 5, 999],
      });

      expect(prisma.forumPost.create).toHaveBeenCalledWith({
        data: objectMatching({
          content:
            'Please help me with my submission.\n<!-- forum-tags:[2,5] -->',
        }),
        include: anyArg(Object),
      });
      expect(result.content).toBe('Please help me with my submission.');
      expect(result.tagged_user_ids).toEqual([2, 5]);
      expect(result.tagged_users).toHaveLength(2);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        2,
        objectMatching({
          title: 'Tagged in Forum Post',
          category: 'forum',
          link: '/CoordinatorForum',
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        5,
        objectMatching({
          title: 'Tagged in Forum Post',
          category: 'forum',
          link: '/grantForum',
        }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        2,
        'forum:post_tagged',
        objectMatching({ post_id: 55 }),
      );
    });

    it('resolves @Name mentions in post content and parses stored tags in getPosts', async () => {
      prisma.user.findMany.mockResolvedValue(makeStaffRows());
      prisma.forumPost.findMany.mockResolvedValue([
        makePost({
          content:
            'Hi @Elena Reyes please check my COR.\n<!-- forum-tags:[2] -->',
        }),
      ]);

      const result = await service.getPosts({});

      expect(result.posts[0].content).toBe(
        'Hi @Elena Reyes please check my COR.',
      );
      expect(result.posts[0].tagged_user_ids).toEqual([2, 5]);
      expect(result.posts[0].tagged_users).toHaveLength(2);
    });

    it('notifies only newly tagged staff when a post is updated', async () => {
      prisma.user.findMany.mockResolvedValue(makeStaffRows());
      prisma.forumPost.findUnique.mockResolvedValue(
        makePost({
          content: 'Initial content\n<!-- forum-tags:[2] -->',
        }),
      );

      const result = await service.updatePost(7, 55, {
        content: 'Updated content',
        tagged_user_ids: [2, 5],
      });

      expect(result.content).toBe('Updated content');
      expect(result.tagged_user_ids).toEqual([2, 5]);
      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        5,
        objectMatching({ link: '/grantForum' }),
      );
    });

    it('excludes the requesting user from getTaggableStaff', async () => {
      prisma.user.findMany.mockResolvedValue(makeStaffRows());

      const staff = await service.getTaggableStaff(2);

      expect(staff.map((s) => s.user_id)).toEqual([5]);
    });

    it('prevents the post owner from tagging themselves via ids or @Name mention', async () => {
      prisma.user.findMany.mockResolvedValue(makeStaffRows());
      prisma.forumPost.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(
            makePost({
              author_user_id: 2,
              content: data.content,
              author: makeAuthor({
                user_id: 2,
                role: 'COORDINATOR',
                scholar_profile: null,
                employee: {
                  first_name: 'Maria',
                  last_name: 'Santos',
                  avatar_url: null,
                },
              }),
            }),
          ),
      );

      const result = await service.createPost(2, {
        title: 'Coordinator self tag attempt',
        content: 'Ping @Maria Santos and @Elena Reyes please.',
        tagged_user_ids: [2, 5],
      });

      expect(result.tagged_user_ids).toEqual([5]);
      expect(result.tagged_users).toHaveLength(1);
      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        5,
        objectMatching({ link: '/grantForum' }),
      );
    });
  });

  describe('togglePin', () => {
    it('throws NotFoundException when the post does not exist', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(service.togglePin(999)).rejects.toThrow(
        new NotFoundException('Forum post ID 999 not found.'),
      );
    });

    it('flips the is_pinned flag and broadcasts the change', async () => {
      prisma.forumPost.update.mockResolvedValue(makePost({ is_pinned: true }));

      const result = await service.togglePin(55);

      expect(prisma.forumPost.update).toHaveBeenCalledWith({
        where: { post_id: 55 },
        data: { is_pinned: true },
      });
      expect(events.emitToAll).toHaveBeenCalledWith('forum:post_updated', {
        postId: 55,
        is_pinned: true,
      });
      expect(result.is_pinned).toBe(true);
    });
  });
});
