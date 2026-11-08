import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { EventsGateway } from './events.gateway.js';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Socket, Server } from 'socket.io';

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let mockJwtService: { verifyAsync: Mock };
  let mockConfigService: { get: Mock };

  beforeEach(async () => {
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
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('should handle ping and return pong', () => {
    expect(gateway.handlePing()).toEqual({ event: 'pong', data: 'pong' });
  });

  it('should reject connection if no token provided', async () => {
    const mockSocket = {
      id: 'test-socket-id',
      handshake: {
        headers: {},
        auth: {},
        query: {},
      },
      disconnect: vi.fn(),
      join: vi.fn(),
    };

    await gateway.handleConnection(mockSocket as unknown as Socket);
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });

  it('should authenticate valid JWT and join rooms', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({
      sub: 42,
      email: 'coordinator@example.com',
      role: 'COORDINATOR',
    });

    gateway.server = {
      emit: vi.fn(),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    } as unknown as Server;

    const mockSocket = {
      id: 'test-socket-id',
      handshake: {
        headers: { authorization: 'Bearer valid.jwt.token' },
        auth: {},
        query: {},
      },
      data: {} as Record<string, unknown>,
      disconnect: vi.fn(),
      emit: vi.fn(),
      join: vi.fn().mockResolvedValue(undefined),
    };

    await gateway.handleConnection(mockSocket as unknown as Socket);

    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(mockSocket.join).toHaveBeenCalledWith('user_42');
    expect(mockSocket.join).toHaveBeenCalledWith('staff');
    expect(mockSocket.join).toHaveBeenCalledWith('coordinators');
    expect(mockSocket.data['user']).toEqual({
      userId: 42,
      email: 'coordinator@example.com',
      role: 'COORDINATOR',
    });
  });

  it('should reject connection on invalid JWT', async () => {
    mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    const mockSocket = {
      id: 'test-socket-id',
      handshake: {
        headers: { authorization: 'Bearer expired.token' },
        auth: {},
        query: {},
      },
      data: {},
      disconnect: vi.fn(),
      join: vi.fn(),
    };

    await gateway.handleConnection(mockSocket as unknown as Socket);
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });

  it('should emit to staff room', () => {
    const mockEmit = vi.fn();
    const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
    gateway.server = { to: mockTo, emit: vi.fn() } as unknown as Server;

    gateway.emitToStaff('application:submitted', { id: 1 });
    expect(mockTo).toHaveBeenCalledWith('staff');
    expect(mockEmit).toHaveBeenCalledWith('application:submitted', { id: 1 });
  });

  it('should emit to user room', () => {
    const mockEmit = vi.fn();
    const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
    gateway.server = { to: mockTo, emit: vi.fn() } as unknown as Server;

    gateway.emitToUser(99, 'application:stage_updated', { status: 'APPROVED' });
    expect(mockTo).toHaveBeenCalledWith('user_99');
    expect(mockEmit).toHaveBeenCalledWith('application:stage_updated', {
      status: 'APPROVED',
    });
  });
});
