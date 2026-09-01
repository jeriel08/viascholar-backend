import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MailService } from './mail.service.js';

@Global()
@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
