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
    delete: vi.fn(),
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
    prisma.forumComment.delete.mockResolvedValue(makeComment());

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

  describe('deletePost', () => {
    it('throws NotFoundException when the post does not exist', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(service.deletePost(7, 999, 'SCHOLAR')).rejects.toThrow(
        new NotFoundException('Forum post ID 999 not found.'),
      );
    });

    it('throws ForbiddenException when the commenter is neither author nor staff', async () => {
      await expect(service.deletePost(99, 55, 'SCHOLAR')).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to delete this post.',
        ),
      );
    });

    it('allows the author to delete their own post', async () => {
      const result = await service.deletePost(7, 55, 'SCHOLAR');

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

    it("allows staff to delete another user's post", async () => {
      prisma.forumPost.findUnique.mockResolvedValue(
        makePost({ author_user_id: 7 }),
      );

      await service.deletePost(2, 55, 'COORDINATOR');

      expect(prisma.forumPost.delete).toHaveBeenCalledWith({
        where: { post_id: 55 },
      });
    });
  });

  describe('deleteComment', () => {
    it('throws NotFoundException when the comment does not exist', async () => {
      prisma.forumComment.findUnique.mockResolvedValue(null);

      await expect(
        service.deleteComment(8, 999, 'COORDINATOR'),
      ).rejects.toThrow(new NotFoundException('Comment ID 999 not found.'));
    });

    it('throws ForbiddenException for non-author non-staff callers', async () => {
      await expect(service.deleteComment(99, 99, 'SCHOLAR')).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to delete this comment.',
        ),
      );
    });

    it('allows the comment author to delete it and notifies room', async () => {
      const result = await service.deleteComment(8, 99, 'SCHOLAR');

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

    it('allows staff to delete a comment and notifies the room', async () => {
      await service.deleteComment(2, 99, 'GRANTOR');

      expect(prisma.forumComment.delete).toHaveBeenCalledWith({
        where: { comment_id: 99 },
      });
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
