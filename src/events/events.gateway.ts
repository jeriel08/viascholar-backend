import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Injectable, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

export interface AuthenticatedSocketUser {
  userId: number;
  email: string;
  role: string;
}

interface TokenPayload {
  sub: number;
  email: string;
  role: string;
}

interface SocketClientData {
  user?: AuthenticatedSocketUser;
}

interface SocketHandshakeAuth {
  token?: unknown;
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  private readonly onlineUsers = new Map<number, Set<string>>();

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const authHeader = client.handshake.headers.authorization;
      const handshakeAuth = client.handshake.auth as SocketHandshakeAuth;
      const authPayload = handshakeAuth?.token;
      const queryToken = client.handshake.query?.token;

      let rawToken: string | undefined;
      if (typeof authPayload === 'string') {
        rawToken = authPayload;
      } else if (typeof authHeader === 'string') {
        rawToken = authHeader;
      } else if (typeof queryToken === 'string') {
        rawToken = queryToken;
      }

      if (!rawToken) {
        this.logger.warn(
          `[Socket] Connection rejected: No auth token provided (${client.id})`,
        );
        client.disconnect(true);
        return;
      }

      const token = rawToken.startsWith('Bearer ')
        ? rawToken.slice(7)
        : rawToken;
      const secret =
        this.configService?.get<string>('JWT_SECRET') ||
        process.env.JWT_SECRET ||
        'viascholar-super-secret-key';
      const payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        secret,
      });

      const user: AuthenticatedSocketUser = {
        userId: payload.sub,
        email: payload.email,
        role: payload.role,
      };
      (client.data as SocketClientData).user = user;

      // Join individual user room for personal updates
      await client.join(`user_${user.userId}`);

      // Join staff / coordinators room if privileged
      const staffRoles = ['ADMIN', 'COORDINATOR', 'GRANTOR'];
      if (staffRoles.includes(user.role)) {
        await client.join('staff');
        await client.join('coordinators');
      }

      // Join admin room if administrator
      if (user.role === 'ADMIN') {
        await client.join('admin');
      }

      // Presence tracking
      const isFirstSocketForUser = !this.onlineUsers.has(user.userId);
      if (isFirstSocketForUser) {
        this.onlineUsers.set(user.userId, new Set());
      }
      this.onlineUsers.get(user.userId)!.add(client.id);

      // Send active presence state to newly connected client
      client.emit('presence:state', {
        onlineUserIds: Array.from(this.onlineUsers.keys()),
      });

      // Broadcast user online if newly active
      if (isFirstSocketForUser) {
        this.server.emit('presence:user_online', {
          userId: user.userId,
          role: user.role,
        });
      }

      this.logger.log(
        `[Socket] Connected: ${client.id} (User: ${user.userId}, Role: ${user.role}, Online users: ${this.onlineUsers.size})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[Socket] Connection rejected: Invalid JWT (${client.id}) - ${message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const user = (client.data as SocketClientData)?.user;
    if (user?.userId && this.onlineUsers.has(user.userId)) {
      const socketSet = this.onlineUsers.get(user.userId)!;
      socketSet.delete(client.id);
      if (socketSet.size === 0) {
        this.onlineUsers.delete(user.userId);
        this.server?.emit('presence:user_offline', {
          userId: user.userId,
        });
      }
    }
    this.logger.log(`[Socket] Disconnected: ${client.id}`);
  }

  @SubscribeMessage('presence:get_online')
  handleGetOnline(): { onlineUserIds: number[] } {
    return { onlineUserIds: Array.from(this.onlineUsers.keys()) };
  }

  @SubscribeMessage('ping')
  handlePing(): { event: string; data: string } {
    return { event: 'pong', data: 'pong' };
  }

  @SubscribeMessage('chat:join_conversation')
  @SubscribeMessage('chat:join_room')
  async handleJoinConversation(
    client: Socket,
    payload: { conversationId: number },
  ) {
    const convoId = Number(payload?.conversationId);
    if (convoId) {
      await client.join(`conversation_${convoId}`);
      return { status: 'joined', conversationId: convoId };
    }
  }

  @SubscribeMessage('chat:leave_conversation')
  @SubscribeMessage('chat:leave_room')
  async handleLeaveConversation(
    client: Socket,
    payload: { conversationId: number },
  ) {
    const convoId = Number(payload?.conversationId);
    if (convoId) {
      await client.leave(`conversation_${convoId}`);
      return { status: 'left', conversationId: convoId };
    }
  }

  @SubscribeMessage('chat:typing')
  handleTyping(
    client: Socket,
    payload: { conversationId: number; isTyping: boolean },
  ) {
    const convoId = Number(payload?.conversationId);
    if (convoId) {
      const user = (client.data as SocketClientData)?.user;
      client.to(`conversation_${convoId}`).emit('chat:typing', {
        conversationId: convoId,
        userId: user?.userId,
        isTyping: Boolean(payload.isTyping),
      });
    }
  }

  @SubscribeMessage('forum:join_post')
  async handleJoinForumPost(client: Socket, payload: { postId: number }) {
    if (payload?.postId) {
      await client.join(`forum_post_${payload.postId}`);
      return { status: 'joined', postId: payload.postId };
    }
  }

  @SubscribeMessage('forum:leave_post')
  async handleLeaveForumPost(client: Socket, payload: { postId: number }) {
    if (payload?.postId) {
      await client.leave(`forum_post_${payload.postId}`);
      return { status: 'left', postId: payload.postId };
    }
  }

  emitToRoom(room: string, event: string, data: unknown) {
    if (this.server) {
      this.server.to(room).emit(event, data);
    }
  }

  emitToAdmin(event: string, data: unknown) {
    if (this.server) {
      this.server.to('admin').emit(event, data);
    }
  }

  emitToStaff(event: string, data: unknown) {
    if (this.server) {
      this.server.to('staff').emit(event, data);
    }
  }

  emitToUser(userId: number, event: string, data: unknown) {
    if (this.server) {
      this.server.to(`user_${userId}`).emit(event, data);
    }
  }

  emitToAll(event: string, data: unknown) {
    if (this.server) {
      this.server.emit(event, data);
    }
  }
}
