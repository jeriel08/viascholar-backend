import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventsGateway } from './events.gateway.js';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Socket, Server } from 'socket.io';

const makeSocket = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-socket-id',
  handshake: {
    headers: {},
    auth: {},
    query: {},
    ...(overrides.handshake as object),
  },
  data: {},
  disconnect: vi.fn(),
  emit: vi.fn(),
  join: vi.fn().mockResolvedValue(undefined),
  leave: vi.fn().mockResolvedValue(undefined),
  to: vi.fn(() => ({ emit: vi.fn() })),
  ...overrides,
});

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let mockJwtService: { verifyAsync: Mock };
  let mockConfigService: { get: Mock };

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockJwtService = {
      verifyAsync: vi.fn(),
    };
    mockConfigService = {
      get: vi.fn().mockReturnValue('test-secret'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsGateway,
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    gateway = module.get<EventsGateway>(EventsGateway);
    // NestJS attaches the @WebSocketServer() `server` field before any
    // connection/handler runs; mirror that in tests.
    gateway.server = {
      emit: vi.fn(),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    } as unknown as Server;
  });

  it('is created by the Nest testing module', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    it('rejects a client with no token anywhere', async () => {
      const socket = makeSocket();

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('verifies a Bearer-scoped authorization header', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 42,
        email: 'coordinator@example.com',
        role: 'COORDINATOR',
      });

      const socket = makeSocket({
        handshake: {
          headers: { authorization: 'Bearer valid.jwt.token' },
          auth: {},
          query: {},
        },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith(
        'valid.jwt.token',
        {
          secret: 'test-secret',
        },
      );
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('uses the auth.token payload when present', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });

      const socket = makeSocket({
        handshake: {
          headers: {},
          auth: { token: 'auth-payload.token' },
          query: {},
        },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith(
        'auth-payload.token',
        { secret: 'test-secret' },
      );
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('uses the query token when provided without other sources', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });

      const socket = makeSocket({
        handshake: {
          headers: {},
          auth: {},
          query: { token: 'query.token' },
        },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('query.token', {
        secret: 'test-secret',
      });
    });

    it('falls back to the default secret when the config is missing', async () => {
      delete process.env.JWT_SECRET;
      mockConfigService.get.mockReturnValue(undefined);
      mockJwtService.verifyAsync.mockRejectedValue(new Error('bad'));

      const socket = makeSocket({
        handshake: {
          headers: { authorization: 'Bearer token' },
          auth: {},
          query: {},
        },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('token', {
        secret: 'viascholar-super-secret-key',
      });
    });

    it('joins staff and coordinator rooms for coordinators', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 42,
        email: 'coordinator@example.com',
        role: 'COORDINATOR',
      });
      gateway.server = {
        emit: vi.fn(),
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Server;

      const socket = makeSocket({
        handshake: { headers: { authorization: 'Bearer abc' } },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.join).toHaveBeenCalledWith('user_42');
      expect(socket.join).toHaveBeenCalledWith('staff');
      expect(socket.join).toHaveBeenCalledWith('coordinators');
      expect(socket.join).not.toHaveBeenCalledWith('admin');
    });

    it('joins the staff room for grantors and the admin room for admins', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 3,
        email: 'grantor@example.com',
        role: 'GRANTOR',
      });

      const grantor = makeSocket({
        id: 'grantor-socket',
        handshake: {
          headers: { authorization: 'Bearer grantor.token' },
          auth: {},
          query: {},
        },
      });
      await gateway.handleConnection(grantor as unknown as Socket);
      expect(grantor.join).toHaveBeenCalledWith('staff');
      expect(grantor.join).toHaveBeenCalledWith('coordinators');

      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 4,
        email: 'admin@example.com',
        role: 'ADMIN',
      });
      const admin = makeSocket({
        id: 'admin-socket',
        handshake: {
          headers: { authorization: 'Bearer admin.token' },
          auth: {},
          query: {},
        },
      });
      await gateway.handleConnection(admin as unknown as Socket);
      expect(admin.join).toHaveBeenCalledWith('staff');
      expect(admin.join).toHaveBeenCalledWith('coordinators');
      expect(admin.join).toHaveBeenCalledWith('admin');
    });

    it('does not join staff rooms for a scholar', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });

      const socket = makeSocket({
        handshake: {
          headers: { authorization: 'Bearer scholar.token' },
          auth: {},
          query: {},
        },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.join).toHaveBeenCalledWith('user_7');
      expect(socket.join).not.toHaveBeenCalledWith('staff');
      expect(socket.join).not.toHaveBeenCalledWith('admin');
    });

    it('emits presence state on connection and broadcasts the first socket only', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });
      const broadcastEmit = vi.fn();
      gateway.server = {
        emit: broadcastEmit,
      } as unknown as Server;

      const handshake = {
        headers: { authorization: 'Bearer scholar.token' },
        auth: {},
        query: {},
      };
      const first = makeSocket({ id: 'first', handshake });
      const second = makeSocket({ id: 'second', handshake });

      await gateway.handleConnection(first as unknown as Socket);
      await gateway.handleConnection(second as unknown as Socket);

      expect(first.emit).toHaveBeenCalledWith(
        'presence:state',
        expect.objectContaining({ onlineUserIds: [7] }),
      );
      expect(broadcastEmit).toHaveBeenCalledWith('presence:user_online', {
        userId: 7,
        role: 'SCHOLAR',
      });
      expect(broadcastEmit).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast presence:user_online for a second concurrent socket', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });
      const broadcastEmit = vi.fn();
      gateway.server = { emit: broadcastEmit } as unknown as Server;

      const handshake = {
        headers: { authorization: 'Bearer scholar.token' },
        auth: {},
        query: {},
      };
      const first = makeSocket({ id: 'first', handshake });
      const second = makeSocket({ id: 'second', handshake });

      await gateway.handleConnection(first as unknown as Socket);
      broadcastEmit.mockClear();
      await gateway.handleConnection(second as unknown as Socket);

      expect(broadcastEmit).not.toHaveBeenCalledWith(
        'presence:user_online',
        expect.any(Object),
      );
    });

    it('rejects on invalid JWT', async () => {
      mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      const socket = makeSocket({
        handshake: { headers: { authorization: 'Bearer expired.token' } },
      });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('handleDisconnect', () => {
    it('ignores disconnects for sockets with no user attached', () => {
      const socket = makeSocket();
      socket.data = {};

      expect(() =>
        gateway.handleDisconnect(socket as unknown as Socket),
      ).not.toThrow();
    });

    it('keeps the user online while another socket remains open', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });
      const broadcastEmit = vi.fn();
      gateway.server = { emit: broadcastEmit } as unknown as Server;

      const first = makeSocket({ id: 'first' });
      const second = makeSocket({ id: 'second' });

      await gateway.handleConnection(first as unknown as Socket);
      await gateway.handleConnection(second as unknown as Socket);

      broadcastEmit.mockClear();
      gateway.handleDisconnect(first as unknown as Socket);

      expect(broadcastEmit).not.toHaveBeenCalledWith(
        'presence:user_offline',
        expect.any(Object),
      );
    });

    it('broadcasts user_offline when the last socket for a user closes', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });
      const broadcastEmit = vi.fn();
      gateway.server = { emit: broadcastEmit } as unknown as Server;

      const socket = makeSocket({
        id: 'only',
        handshake: {
          headers: { authorization: 'Bearer scholar.token' },
          auth: {},
          query: {},
        },
      });

      await gateway.handleConnection(socket as unknown as Socket);
      broadcastEmit.mockClear();

      gateway.handleDisconnect(socket as unknown as Socket);

      expect(broadcastEmit).toHaveBeenCalledWith('presence:user_offline', {
        userId: 7,
      });
    });
  });

  describe('ping and presence handlers', () => {
    it('returns pong from the ping handler', () => {
      expect(gateway.handlePing()).toEqual({ event: 'pong', data: 'pong' });
    });

    it('returns the list of currently online users', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 7,
        email: 'scholar@example.com',
        role: 'SCHOLAR',
      });
      gateway.server = { emit: vi.fn() } as unknown as Server;

      const socket = makeSocket({
        id: 'online-socket',
        handshake: {
          headers: { authorization: 'Bearer scholar.token' },
          auth: {},
          query: {},
        },
      });
      await gateway.handleConnection(socket as unknown as Socket);

      expect(gateway.handleGetOnline()).toEqual({ onlineUserIds: [7] });
    });
  });

  describe('room join and leave handlers', () => {
    it('joins a conversation room when the id parses', async () => {
      const socket = makeSocket();

      const result = await gateway.handleJoinConversation(
        socket as unknown as Socket,
        {
          conversationId: 55,
        },
      );

      expect(socket.join).toHaveBeenCalledWith('conversation_55');
      expect(result).toEqual({ status: 'joined', conversationId: 55 });
    });

    it('does nothing for an unparseable conversation id on join', async () => {
      const socket = makeSocket();

      const result = await gateway.handleJoinConversation(
        socket as unknown as Socket,
        {
          conversationId: Number.NaN,
        },
      );

      expect(socket.join).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('leaves a conversation room when the id parses', async () => {
      const socket = makeSocket();

      const result = await gateway.handleLeaveConversation(
        socket as unknown as Socket,
        {
          conversationId: 55,
        },
      );

      expect(socket.leave).toHaveBeenCalledWith('conversation_55');
      expect(result).toEqual({ status: 'left', conversationId: 55 });
    });

    it('does nothing for an unparseable conversation id on leave', async () => {
      const socket = makeSocket();

      const result = await gateway.handleLeaveConversation(
        socket as unknown as Socket,
        {
          conversationId: 0,
        },
      );

      expect(socket.leave).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('joins and leaves a forum post room', async () => {
      const socket = makeSocket();

      const joinResult = await gateway.handleJoinForumPost(
        socket as unknown as Socket,
        {
          postId: 9,
        },
      );
      const leaveResult = await gateway.handleLeaveForumPost(
        socket as unknown as Socket,
        {
          postId: 9,
        },
      );

      expect(socket.join).toHaveBeenCalledWith('forum_post_9');
      expect(socket.leave).toHaveBeenCalledWith('forum_post_9');
      expect(joinResult).toEqual({ status: 'joined', postId: 9 });
      expect(leaveResult).toEqual({ status: 'left', postId: 9 });
    });

    it('ignores forum handlers with a falsy post id', async () => {
      const socket = makeSocket();

      expect(
        await gateway.handleJoinForumPost(socket as unknown as Socket, {
          postId: 0,
        }),
      ).toBeUndefined();
      expect(
        await gateway.handleLeaveForumPost(socket as unknown as Socket, {
          postId: 0,
        }),
      ).toBeUndefined();
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.leave).not.toHaveBeenCalled();
    });

    it('broadcasts typing events to the conversation room', () => {
      const roomEmit = vi.fn();
      const toMock = vi.fn().mockReturnValue({ emit: roomEmit });
      const socket = makeSocket();
      socket.data = {
        user: { userId: 7, email: 's@example.com', role: 'SCHOLAR' },
      };
      socket.to = toMock as never;

      gateway.handleTyping(socket as unknown as Socket, {
        conversationId: 55,
        isTyping: true,
      });

      expect(toMock).toHaveBeenCalledWith('conversation_55');
      expect(roomEmit).toHaveBeenCalledWith('chat:typing', {
        conversationId: 55,
        userId: 7,
        isTyping: true,
      });
    });

    it('ignores typing events with an invalid conversation id', () => {
      const toMock = vi.fn();
      const socket = makeSocket();
      socket.to = toMock as never;

      gateway.handleTyping(socket as unknown as Socket, {
        conversationId: 0,
        isTyping: true,
      });

      expect(toMock).not.toHaveBeenCalled();
    });
  });

  describe('emit helpers', () => {
    it('broadcasts to the given room', () => {
      const emit = vi.fn();
      const to = vi.fn().mockReturnValue({ emit });
      gateway.server = { to, emit: vi.fn() } as unknown as Server;

      gateway.emitToRoom('room-1', 'event', { a: 1 });

      expect(to).toHaveBeenCalledWith('room-1');
      expect(emit).toHaveBeenCalledWith('event', { a: 1 });
    });

    it('emitToAdmin sends only to the admin room', () => {
      const emit = vi.fn();
      const to = vi.fn().mockReturnValue({ emit });
      gateway.server = { to, emit: vi.fn() } as unknown as Server;

      gateway.emitToAdmin('audit:new_log', { action: 'PING' });

      expect(to).toHaveBeenCalledWith('admin');
      expect(emit).toHaveBeenCalledWith('audit:new_log', { action: 'PING' });
    });

    it('emitToStaff sends only to the staff room', () => {
      const emit = vi.fn();
      const to = vi.fn().mockReturnValue({ emit });
      gateway.server = { to, emit: vi.fn() } as unknown as Server;

      gateway.emitToStaff('application:submitted', { id: 1 });

      expect(to).toHaveBeenCalledWith('staff');
      expect(emit).toHaveBeenCalledWith('application:submitted', { id: 1 });
    });

    it('emitToUser sends only to the personal user room', () => {
      const emit = vi.fn();
      const to = vi.fn().mockReturnValue({ emit });
      gateway.server = { to, emit: vi.fn() } as unknown as Server;

      gateway.emitToUser(99, 'application:stage_updated', {
        status: 'APPROVED',
      });

      expect(to).toHaveBeenCalledWith('user_99');
      expect(emit).toHaveBeenCalledWith('application:stage_updated', {
        status: 'APPROVED',
      });
    });

    it('emitToAll broadcasts to every connected client', () => {
      const emit = vi.fn();
      gateway.server = { emit } as unknown as Server;

      gateway.emitToAll('settings:updated', { theme: 'dark' });

      expect(emit).toHaveBeenCalledWith('settings:updated', { theme: 'dark' });
    });

    it('does not throw when the server is not attached yet', () => {
      gateway.server = undefined as never;

      expect(() => gateway.emitToRoom('r', 'e', {})).not.toThrow();
      expect(() => gateway.emitToAdmin('e', {})).not.toThrow();
      expect(() => gateway.emitToStaff('e', {})).not.toThrow();
      expect(() => gateway.emitToUser(1, 'e', {})).not.toThrow();
      expect(() => gateway.emitToAll('e', {})).not.toThrow();
    });
  });
});
