import { describe, expect, test } from 'bun:test';
import { buildS3ObjectKey, createS3ClientFromConfig, normalizeS3CustomPath, normalizeS3Endpoint } from '../../../lib/s3Storage';

describe('S3 storage path helpers', () => {
  test('stores objects in the bucket root when custom path is empty', () => {
    expect(normalizeS3CustomPath('')).toBe('');
    expect(buildS3ObjectKey('', 'note.png')).toBe('note.png');
  });

  test('normalizes custom paths with a trailing slash', () => {
    expect(normalizeS3CustomPath('/custom/path/')).toBe('custom/path/');
    expect(buildS3ObjectKey('custom/path', 'note.png')).toBe('custom/path/note.png');
  });

  test('rejects path traversal style segments', () => {
    expect(() => normalizeS3CustomPath('../private')).toThrow('Custom Path contains an invalid path segment');
    expect(() => normalizeS3CustomPath('safe/../private')).toThrow('Custom Path contains an invalid path segment');
  });

  test('normalizes endpoint protocol and trailing slash', () => {
    expect(normalizeS3Endpoint('oss-cn-beijing.aliyuncs.com/')).toBe('https://oss-cn-beijing.aliyuncs.com');
    expect(normalizeS3Endpoint('http://oss-cn-beijing.aliyuncs.com/')).toBe('http://oss-cn-beijing.aliyuncs.com');
  });

  test('uses virtual-hosted style by default and allows path-style fallback', async () => {
    const client = createS3ClientFromConfig({
      s3Endpoint: 'https://oss-cn-beijing.aliyuncs.com',
      s3Region: 'beijing',
      s3AccessKeyId: 'access-key',
      s3AccessKeySecret: 'secret-key',
    });

    expect(client.config.forcePathStyle).toBe(false);

    const pathStyleClient = createS3ClientFromConfig({
      s3Endpoint: 'https://oss-cn-beijing.aliyuncs.com',
      s3Region: 'beijing',
      s3AccessKeyId: 'access-key',
      s3AccessKeySecret: 'secret-key',
      s3ForcePathStyle: true,
    });

    expect(pathStyleClient.config.forcePathStyle).toBe(true);
  });
});
