import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SmsModule } from '../sms/sms.module.js';
import { MailService } from './mail.service.js';

@Global()
@Module({
  imports: [ConfigModule, PrismaModule, SmsModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
