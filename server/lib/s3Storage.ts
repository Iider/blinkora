import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

type S3StorageConfig = {
  s3Endpoint?: unknown;
  s3Region?: unknown;
  s3Bucket?: unknown;
  s3AccessKeyId?: unknown;
  s3AccessKeySecret?: unknown;
  s3CustomPath?: unknown;
  s3ForcePathStyle?: unknown;
};

const parseBoolean = (value: unknown) => value === true || value === 'true';

const readRequiredString = (config: S3StorageConfig, key: keyof S3StorageConfig, label: string) => {
  const value = String(config[key] ?? '').trim();
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
};

export const normalizeS3CustomPath = (customPath?: unknown) => {
  const value = String(customPath ?? '').trim().replace(/\\/g, '/');
  if (!value) {
    return '';
  }

  const pathParts = value
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);

  if (pathParts.some(part => part === '.' || part === '..')) {
    throw new Error('Custom Path contains an invalid path segment');
  }

  return pathParts.length ? `${pathParts.join('/')}/` : '';
};

export const normalizeS3Endpoint = (endpoint?: unknown) => {
  const value = readRequiredString({ s3Endpoint: endpoint }, 's3Endpoint', 'Endpoint');
  const normalizedValue = /^[a-z][a-z\d+\-.]*:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(normalizedValue);
    if (url.pathname === '/') {
      url.pathname = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Endpoint must be a valid URL');
  }
};

export const buildS3ObjectKey = (customPath: unknown, fileName: string) => {
  return `${normalizeS3CustomPath(customPath)}${fileName.replace(/^\/+/, '')}`;
};

export const createS3ClientFromConfig = (config: S3StorageConfig, options: { forcePathStyle?: boolean } = {}) => {
  const endpoint = normalizeS3Endpoint(config.s3Endpoint);
  const region = readRequiredString(config, 's3Region', 'Region ID');
  const accessKeyId = readRequiredString(config, 's3AccessKeyId', 'Access Key');
  const secretAccessKey = readRequiredString(config, 's3AccessKeySecret', 'Secret Key');
  const forcePathStyle = options.forcePathStyle ?? parseBoolean(config.s3ForcePathStyle);

  return new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle,
  });
};

const drainResponseBody = async (body: unknown) => {
  if (!body || typeof (body as any)[Symbol.asyncIterator] !== 'function') {
    return;
  }

  for await (const _chunk of body as AsyncIterable<unknown>) {
    // Consume the response stream so the SDK can release the connection.
  }
};

const validateS3StorageConfigWithPathStyle = async (config: S3StorageConfig, forcePathStyle: boolean) => {
  const s3Client = createS3ClientFromConfig(config, { forcePathStyle });
  const validationKey = buildS3ObjectKey(
    config.s3CustomPath,
    `.blinkora-s3-validation-${Date.now()}.txt`
  );
  let uploadedValidationObject = false;

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: readRequiredString(config, 's3Bucket', 'Bucket'),
      Key: validationKey,
      Body: 'blinkora s3 validation',
      ContentType: 'text/plain; charset=utf-8',
    }));
    uploadedValidationObject = true;

    const response = await s3Client.send(new GetObjectCommand({
      Bucket: readRequiredString(config, 's3Bucket', 'Bucket'),
      Key: validationKey,
    }));
    await drainResponseBody(response.Body);

    await s3Client.send(new DeleteObjectCommand({
      Bucket: readRequiredString(config, 's3Bucket', 'Bucket'),
      Key: validationKey,
    }));
    uploadedValidationObject = false;

    return {
      validationKey,
      forcePathStyle,
      normalizedEndpoint: normalizeS3Endpoint(config.s3Endpoint),
      normalizedCustomPath: normalizeS3CustomPath(config.s3CustomPath),
    };
  } catch (error) {
    if (uploadedValidationObject) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: readRequiredString(config, 's3Bucket', 'Bucket'),
          Key: validationKey,
        }));
      } catch {
        // Keep the original validation error as the actionable failure.
      }
    }

    throw error;
  }
};

export const formatS3ValidationError = (error: unknown) => {
  if (error instanceof Error) {
    const metadata = (error as any).$metadata;
    const statusCode = metadata?.httpStatusCode ? `HTTP ${metadata.httpStatusCode}` : '';
    return [error.name, statusCode, error.message].filter(Boolean).join(': ');
  }

  return String(error || 'Unknown S3 validation error');
};

export const validateS3StorageConfig = async (config: S3StorageConfig) => {
  readRequiredString(config, 's3Bucket', 'Bucket');

  const preferredPathStyle = config.s3ForcePathStyle === undefined
    ? false
    : parseBoolean(config.s3ForcePathStyle);
  const attempts = Array.from(new Set([preferredPathStyle, false, true]));
  const errors: string[] = [];

  for (const forcePathStyle of attempts) {
    try {
      return await validateS3StorageConfigWithPathStyle(config, forcePathStyle);
    } catch (error) {
      errors.push(`${forcePathStyle ? 'path-style' : 'virtual-hosted'}: ${formatS3ValidationError(error)}`);
    }
  }

  throw new Error(`S3 validation failed. Tried ${errors.join('; ')}`);
};
