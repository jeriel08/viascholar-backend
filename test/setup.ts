import 'reflect-metadata';

process.env.NODE_ENV = 'test';

// Keep tests deterministic and independent of local .env values.
process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.JWT_EXPIRES_IN ??= '1h';
