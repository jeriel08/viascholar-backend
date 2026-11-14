import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SmsService } from './sms.service.js';

@Global()
@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
