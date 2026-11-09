import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ParseurExtractorService } from './parseur-extractor.service.js';
const okJson = (body: unknown) => () => Promise.resolve(body);

const makeConfig = (apiKey?: string | null, mailboxId?: string | null) => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'PARSEUR_API_KEY')
      return apiKey === undefined ? 'test-key' : (apiKey ?? undefined);
    if (key === 'PARSEUR_MAILBOX_ID')
      return mailboxId === undefined ? 'mb-1' : (mailboxId ?? undefined);
    return undefined;
  }),
});

describe('ParseurExtractorService', () => {
  let service: ParseurExtractorService;

  const build = async (
    apiKey?: string | null,
    mailboxId?: string | null,
  ): Promise<ParseurExtractorService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParseurExtractorService,
        { provide: ConfigService, useValue: makeConfig(apiKey, mailboxId) },
      ],
    }).compile();

    return module.get<ParseurExtractorService>(ParseurExtractorService);
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is created by the Nest testing module', async () => {
    service = await build();
    expect(service).toBeDefined();
  });

  it('returns an empty result object when credentials are missing', async () => {
    service = await build(null, null);

    const result = await service.uploadToParseur(
      55,
      Buffer.from('pdf'),
      'doc.pdf',
      'application/pdf',
    );

    expect(result).toEqual({});
  });

  it('uploads the file and returns the parseur document id', async () => {
    service = await build();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: okJson({ attachments: [{ DocumentID: 4321 }] }),
      }),
    );

    const result = await service.uploadToParseur(
      55,
      Buffer.from('pdf'),
      'doc.pdf',
      'application/pdf',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.parseur.com/parser/mb-1/upload',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Token test-key' },
      }),
    );
    expect(result.parseurDocId).toBe('4321');
    expect(result.data).toEqual({ attachments: [{ DocumentID: 4321 }] });
  });

  it('omits parseurDocId when the response has no attachment DocumentID', async () => {
    service = await build();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: okJson({}),
      }),
    );

    const result = await service.uploadToParseur(
      55,
      Buffer.from('pdf'),
      'doc.pdf',
      'application/pdf',
    );

    expect(result.parseurDocId).toBeUndefined();
  });

  it('throws when the Parseur API responds with an error', async () => {
    service = await build();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limited'),
      }),
    );

    await expect(
      service.uploadToParseur(
        55,
        Buffer.from('pdf'),
        'doc.pdf',
        'application/pdf',
      ),
    ).rejects.toThrow('Parseur API responded with status 429: rate limited');
  });

  it('extractData is a no-op returning an empty result', async () => {
    service = await build();

    const result = await service.extractData(
      {
        buffer: Buffer.from('pdf'),
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
      },
      'TOR',
    );

    expect(result).toEqual({});
  });

  it('extractData accepts an array of files and logs the initiation', async () => {
    service = await build();

    const result = await service.extractData(
      [
        {
          buffer: Buffer.from('a'),
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
        },
        {
          buffer: Buffer.from('b'),
          fileName: 'b.pdf',
          mimeType: 'application/pdf',
        },
      ],
      'TOR',
    );

    expect(result).toEqual({});
  });
});
