import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ForumController } from './forum.controller.js';
import { ForumService } from './forum.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/client.js';
import type { CreatePostDto } from './dto/create-post.dto.js';
import type { QueryPostsDto } from './dto/query-posts.dto.js';

const makeRequest = (userId = 7, role = 'SCHOLAR') => ({
  user: { user_id: userId, role },
});

describe('ForumController', () => {
  let controller: ForumController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      createPost: vi.fn(),
      getPosts: vi.fn(),
      getPostById: vi.fn(),
      addComment: vi.fn(),
      deletePost: vi.fn(),
      deleteComment: vi.fn(),
      togglePin: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ForumController],
      providers: [
        {
          provide: ForumService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<ForumController>(ForumController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates createPost with the authenticated user', () => {
    const request = makeRequest();
    const dto = { title: 'Title', content: 'Content' } as CreatePostDto;
    serviceMock.createPost.mockReturnValue({ post_id: 55 });

    void controller.createPost(request, dto);

    expect(serviceMock.createPost).toHaveBeenCalledWith(7, dto);
  });

  it('delegates getPosts with the query object', () => {
    const query = { page: 2, limit: 10, category: 'ACADEMIC' } as QueryPostsDto;
    serviceMock.getPosts.mockReturnValue({ total: 0, posts: [] });

    void controller.getPosts(query);

    expect(serviceMock.getPosts).toHaveBeenCalledWith(query);
  });

  it('delegates getPostById with the parsed id', () => {
    void controller.getPostById(55);

    expect(serviceMock.getPostById).toHaveBeenCalledWith(55);
  });

  it('delegates addComment with user, post id, and dto', () => {
    const request = makeRequest();
    const dto = { content: 'Comment text' };

    void controller.addComment(request, 55, dto);

    expect(serviceMock.addComment).toHaveBeenCalledWith(7, 55, dto);
  });

  it('delegates deletePost with user, id, and role', () => {
    const request = makeRequest(42, 'COORDINATOR');

    void controller.deletePost(request, 55);

    expect(serviceMock.deletePost).toHaveBeenCalledWith(42, 55, 'COORDINATOR');
  });

  it('delegates deleteComment with user, id, and role', () => {
    const request = makeRequest(42, 'COORDINATOR');

    void controller.deleteComment(request, 99);

    expect(serviceMock.deleteComment).toHaveBeenCalledWith(
      42,
      99,
      'COORDINATOR',
    );
  });

  it('delegates togglePin with the parsed id', () => {
    void controller.togglePin(55);

    expect(serviceMock.togglePin).toHaveBeenCalledWith(55);
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = ForumController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts togglePin to staff roles', () => {
      expect(rolesFor(handlerFor('togglePin'))).toEqual([
        Role.ADMIN,
        Role.COORDINATOR,
        Role.GRANTOR,
      ]);
    });

    it('leaves post creation and reading open to all authenticated roles', () => {
      for (const name of [
        'createPost',
        'getPosts',
        'getPostById',
        'addComment',
        'deletePost',
        'deleteComment',
      ]) {
        expect(rolesFor(handlerFor(name))).toBeUndefined();
      }
    });
  });
});
