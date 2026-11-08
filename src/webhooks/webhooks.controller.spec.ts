import { beforeEach, describe, expect, it } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentReconciliationService } from '../documents/services/document-reconciliation.service.js';
import { EventsGateway } from '../events/events.gateway.js';

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: DocumentReconciliationService, useValue: {} },
        { provide: EventsGateway, useValue: {} },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
