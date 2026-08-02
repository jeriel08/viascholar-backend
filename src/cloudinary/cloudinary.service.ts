// src/cloudinary/cloudinary.service.ts
import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';
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

  async uploadImage(
    file: Express.Multer.File,
    folder: string = 'viascholar/avatars',
  ): Promise<UploadApiResponse | UploadApiErrorResponse> {
    if (!file || !file.buffer) {
      throw new BadRequestException('No valid file buffer provided.');
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: folder,
          allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        },
        (error, result) => {
          if (error || !result) {
            console.error('Cloudinary Upload Error:', error);
            return reject(
              new InternalServerErrorException(
                error?.message ||
                  'Cloudinary upload failed or returned empty result.',
              ),
            );
          }

          resolve(result);
        },
      );

      try {
        const stream = streamifier.createReadStream(file.buffer);
        stream.pipe(uploadStream);
      } catch (err) {
        console.error('Streamifier Error:', err);
        reject(
          new InternalServerErrorException('Failed to process image stream.'),
        );
      }
    });
  }
}
