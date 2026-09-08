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
    origin: ['http://localhost:3000', process.env.FRONTEND_URL].filter(
      Boolean,
    ) as string[],
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

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

      this.logger.log(
        `[Socket] Connected: ${client.id} (User: ${user.userId}, Role: ${user.role})`,
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
    this.logger.log(`[Socket] Disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(): { event: string; data: string } {
    return { event: 'pong', data: 'pong' };
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
