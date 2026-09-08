import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CloudinaryModule } from './cloudinary/cloudinary.module.js';
import { AuditModule } from './audit/audit.module.js';
import { UsersModule } from './users/users.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { ApplicationsModule } from './applications/applications.module.js';
import { MeetingsModule } from './meetings/meetings.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { MailModule } from './mail/mail.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    AuthModule,
    CloudinaryModule,
    AuditModule,
    UsersModule,
    SettingsModule,
    ApplicationsModule,
    MeetingsModule,
    WebhooksModule,
    DocumentsModule,
    ContractsModule,
    MailModule,
  ],
  providers: [],
})
export class AppModule {}
