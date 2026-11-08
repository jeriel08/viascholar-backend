import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CloudinaryService } from './cloudinary.service.js';
import { ConfigService } from '@nestjs/config';

vi.mock('streamifier', () => ({
  createReadStream: vi.fn(() => ({ pipe: vi.fn().mockReturnThis() })),
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload_stream: vi.fn(),
    },
  },
}));

import { v2 as cloudinary } from 'cloudinary';

type UploadCallback = (error: unknown, result: unknown) => void;

interface RecordedUploadStream {
  options: Record<string, unknown>;
  callback: UploadCallback;
}

const makeUploadResponse = () =>
  ({
    public_id: 'folder/abc123',
    secure_url: 'https://res.cloudinary.com/test/image/upload/v1/abc123.png',
    resource_type: 'image',
    format: 'png',
    bytes: 1024,
  }) as never;

const makeFile = (overrides: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'photo.png',
    mimetype: 'image/png',
    buffer: Buffer.from('file-contents'),
    size: 2048,
    ...overrides,
  }) as Express.Multer.File;

describe('CloudinaryService', () => {
  let service: CloudinaryService;
  let recordedStreams: RecordedUploadStream[];

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    recordedStreams = [];
    vi.mocked(
      cloudinary.uploader.upload_stream as unknown as ReturnType<typeof vi.fn>,
    ).mockImplementation((options: unknown, callback: unknown) => {
      recordedStreams.push({
        options: options as Record<string, unknown>,
        callback: callback as UploadCallback,
      });
      return { pipe: vi.fn().mockReturnThis() } as never;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudinaryService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn(
              (key: string) =>
                ({
                  CLOUDINARY_CLOUD_NAME: 'test-cloud',
                  CLOUDINARY_API_KEY: 'test-key',
                  CLOUDINARY_API_SECRET: 'test-secret',
                })[key],
            ),
          },
        },
      ],
    }).compile();

    service = module.get<CloudinaryService>(CloudinaryService);
  });

  const completeUpload = (
    index: number,
    error: unknown = null,
    result: unknown = makeUploadResponse(),
  ) => {
    recordedStreams[index].callback(error, result);
  };

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('configures the Cloudinary v2 client from the environment', () => {
      service.onModuleInit();

      expect(cloudinary.config).toHaveBeenCalledWith({
        cloud_name: 'test-cloud',
        api_key: 'test-key',
        api_secret: 'test-secret',
        secure: true,
        timeout: 120000,
      });
    });
  });

  describe('uploadImage', () => {
    it('rejects a missing or buffer-less file', async () => {
      await expect(
        service.uploadImage({
          originalname: 'x.png',
        } as Express.Multer.File),
      ).rejects.toThrow(
        new BadRequestException('No valid file buffer provided.'),
      );
      await expect(service.uploadImage(undefined as never)).rejects.toThrow(
        new BadRequestException('No valid file buffer provided.'),
      );
      expect(recordedStreams).toHaveLength(0);
    });

    it('uploads an image with image resource type and the image format whitelist', async () => {
      const result = makeUploadResponse();
      const uploadPromise = service.uploadImage(makeFile());
      completeUpload(0, null, result);

      await expect(uploadPromise).resolves.toBe(result);
      expect(recordedStreams).toHaveLength(1);
      expect(recordedStreams[0].options).toMatchObject({
        folder: 'viascholar/avatars',
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        timeout: 120000,
      });
    });

    it('rejects when streaming the file to cloudinary fails', async () => {
      const { createReadStream } = await import('streamifier');
      vi.mocked(createReadStream).mockImplementationOnce(() => {
        throw new Error('read stream exploded');
      });

      await expect(service.uploadImage(makeFile())).rejects.toThrow(
        'read stream exploded',
      );
    });
  });

  describe('uploadDocument', () => {
    it('rejects a missing or buffer-less file', async () => {
      await expect(
        service.uploadDocument({
          originalname: 'x.pdf',
        } as Express.Multer.File),
      ).rejects.toThrow(
        new BadRequestException('No valid file buffer provided.'),
      );
      expect(recordedStreams).toHaveLength(0);
    });

    it('treats a PDF document as auto resource type and drops pdf from allowed formats', async () => {
      const result = makeUploadResponse();
      const uploadPromise = service.uploadDocument(
        makeFile({
          originalname: 'transcript.pdf',
          mimetype: 'application/pdf',
        }),
      );
      completeUpload(0, null, result);

      await expect(uploadPromise).resolves.toBe(result);
      expect(recordedStreams).toHaveLength(1);
      expect(recordedStreams[0].options).toMatchObject({
        folder: 'viascholar/documents',
        resource_type: 'auto',
        timeout: 120000,
      });
      expect(recordedStreams[0].options).not.toHaveProperty('allowed_formats');
    });

    it('treats an image document as image type with pdf excluded from allowed formats', async () => {
      const result = makeUploadResponse();
      const uploadPromise = service.uploadDocument(
        makeFile({ originalname: 'slip.png', mimetype: 'image/png' }),
      );
      completeUpload(0, null, result);

      await expect(uploadPromise).resolves.toBe(result);
      expect(recordedStreams[0].options).toMatchObject({
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      });
    });
  });

  describe('uploadBuffer', () => {
    it('rejects an empty buffer', async () => {
      await expect(
        service.uploadBuffer(Buffer.alloc(0), 'folder', 'name.pdf'),
      ).rejects.toThrow(
        new BadRequestException('Empty buffer provided for upload.'),
      );
      expect(recordedStreams).toHaveLength(0);
    });

    it('uploads the buffer with the requested resource type and public id', async () => {
      const result = makeUploadResponse();
      const uploadPromise = service.uploadBuffer(
        Buffer.from('signed-pdf'),
        'viascholar/signed',
        'signed_application_42',
        'raw',
      );
      completeUpload(0, null, result);

      await expect(uploadPromise).resolves.toBe(result);
      expect(recordedStreams).toHaveLength(1);
      expect(recordedStreams[0].options).toEqual({
        folder: 'viascholar/signed',
        public_id: 'signed_application_42',
        resource_type: 'raw',
      });
    });

    it('propagates cloudinary errors instead of swallowing them', async () => {
      const uploadPromise = service.uploadBuffer(
        Buffer.from('data'),
        'folder',
        'name.pdf',
      );
      completeUpload(0, new Error('stream died'), null);

      await expect(uploadPromise).rejects.toThrow('stream died');
    });

    it('rejects when streaming the buffer to cloudinary fails', async () => {
      const { createReadStream } = await import('streamifier');
      vi.mocked(createReadStream).mockImplementationOnce(() => {
        throw new Error('read stream exploded');
      });

      await expect(
        service.uploadBuffer(Buffer.from('data'), 'folder', 'name.pdf'),
      ).rejects.toThrow('read stream exploded');
    });
  });

  describe('streamUpload retry policy', () => {
    const transientError = () => ({
      http_code: 503,
      message: 'service unavailable',
      name: 'CloudinaryError',
    });
    const invalidFormatError = () => ({
      http_code: 400,
      message: 'invalid format',
      name: 'CloudinaryError',
    });

    it('does not retry a non-transient first attempt failure', async () => {
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: (...args: never[]) => void) => {
          fn();
          return 0 as never;
        },
      );

      const uploadPromise = service.uploadImage(makeFile());
      completeUpload(0, invalidFormatError(), null);

      await expect(uploadPromise).rejects.toThrow(InternalServerErrorException);
      expect(recordedStreams).toHaveLength(1);
    });

    it('retries transient failures and succeeds on a later attempt', async () => {
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: (...args: never[]) => void) => {
          fn();
          return 0 as never;
        },
      );

      const uploadPromise = service.uploadImage(makeFile());
      const result = makeUploadResponse();

      expect(recordedStreams).toHaveLength(1);
      completeUpload(0, transientError(), null);

      await vi.waitFor(() =>
        expect(recordedStreams.length).toBeGreaterThanOrEqual(2),
      );
      completeUpload(1, null, result);

      await expect(uploadPromise).resolves.toBe(result);
      expect(recordedStreams).toHaveLength(2);
    });

    it('exhausts retries on transient failures and throws InternalServerErrorException', async () => {
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: (...args: never[]) => void) => {
          fn();
          return 0 as never;
        },
      );

      const uploadPromise = service.uploadImage(makeFile());

      completeUpload(0, transientError(), null);
      await vi.waitFor(() =>
        expect(recordedStreams.length).toBeGreaterThanOrEqual(2),
      );
      completeUpload(1, transientError(), null);
      await vi.waitFor(() =>
        expect(recordedStreams.length).toBeGreaterThanOrEqual(3),
      );
      completeUpload(2, transientError(), null);

      await expect(uploadPromise).rejects.toThrow(InternalServerErrorException);
      expect(recordedStreams).toHaveLength(3);
    });
  });
});
