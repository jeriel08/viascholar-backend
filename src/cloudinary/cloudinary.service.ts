// src/cloudinary/cloudinary.service.ts
import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import * as streamifier from 'streamifier';

@Injectable()
export class CloudinaryService implements OnModuleInit {
  constructor(private configService: ConfigService) {}

  // Automatically runs when NestJS boots up
  onModuleInit() {
    cloudinary.config({
      cloud_name: this.configService.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  private readonly logger = new Logger(CloudinaryService.name);

  private async streamUpload(
    file: Express.Multer.File,
    folder: string,
    allowedFormats: string[],
    maxRetries = 2,
  ): Promise<UploadApiResponse> {
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delayMs = attempt * 1200;
          this.logger.warn(
            `Retrying Cloudinary upload in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        const result = await new Promise<UploadApiResponse>((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: folder,
              allowed_formats: allowedFormats,
            },
            (error, result) => {
              if (error || !result) {
                return reject(
                  error || new Error('Cloudinary returned empty result.'),
                );
              }
              resolve(result);
            },
          );

          try {
            const stream = streamifier.createReadStream(file.buffer);
            stream.pipe(uploadStream);
          } catch (err) {
            reject(err);
          }
        });

        return result;
      } catch (error: any) {
        lastError = error;
        const isRateLimitOrTransient =
          error?.http_code === 429 ||
          error?.statusCode === 429 ||
          error?.name === 'UnexpectedResponse' ||
          String(error?.message).includes('429');

        this.logger.warn(
          `Cloudinary upload attempt ${attempt + 1} failed: ${error?.message || error}`,
        );

        if (!isRateLimitOrTransient && attempt === 0) {
          // Non-transient error (e.g. invalid format); don't retry pointlessly
          break;
        }
      }
    }

    this.logger.error('Cloudinary Upload Error after retries:', lastError);
    throw new InternalServerErrorException(
      lastError?.message || 'Cloudinary upload failed or returned empty result.',
    );
  }

  // Method to handle Avatar/Banner uploads (images only)
  async uploadImage(
    file: Express.Multer.File,
    folder: string = 'viascholar/avatars',
  ): Promise<UploadApiResponse> {
    if (!file || !file.buffer) {
      throw new BadRequestException('No valid file buffer provided.');
    }

    return this.streamUpload(file, folder, ['jpg', 'jpeg', 'png', 'webp']);
  }

  // Method to handle Scholar document uploads (images and PDFs)
  async uploadDocument(
    file: Express.Multer.File,
    folder: string = 'viascholar/documents',
  ): Promise<UploadApiResponse> {
    if (!file || !file.buffer) {
      throw new BadRequestException('No valid file buffer provided.');
    }

    return this.streamUpload(file, folder, [
      'jpg',
      'jpeg',
      'png',
      'webp',
      'pdf',
    ]);
  }

  // Method to handle direct Buffer uploads (e.g. generated signed PDFs, signature PNGs)
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
    resourceType: 'image' | 'raw' | 'auto' = 'auto',
  ): Promise<UploadApiResponse> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Empty buffer provided for upload.');
    }

    return new Promise<UploadApiResponse>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: filename,
          resource_type: resourceType,
        },
        (error, result) => {
          if (error || !result) {
            return reject(
              error ||
                new Error('Cloudinary buffer upload returned empty result.'),
            );
          }
          resolve(result);
        },
      );

      try {
        const stream = streamifier.createReadStream(buffer);
        stream.pipe(uploadStream);
      } catch (err) {
        reject(err);
      }
    });
  }
}

