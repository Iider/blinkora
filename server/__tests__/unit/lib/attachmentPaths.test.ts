import { describe, expect, test } from 'bun:test';
import { extractAttachmentPathsFromContent } from '../../../lib/attachmentPaths';

describe('extractAttachmentPathsFromContent', () => {
  test('extracts local and S3 attachment paths from markdown content', () => {
    const content = '[doc](/api/file/report.txt) ![img](/api/s3file/images/photo.png)';

    expect(extractAttachmentPathsFromContent(content)).toEqual([
      '/api/file/report.txt',
      '/api/s3file/images/photo.png',
    ]);
  });

  test('deduplicates paths and strips query strings', () => {
    const content = '/api/file/a.png?token=secret /api/file/a.png#preview /api/file/b.txt';

    expect(extractAttachmentPathsFromContent(content)).toEqual([
      '/api/file/a.png',
      '/api/file/b.txt',
    ]);
  });

  test('keeps parentheses inside filenames and trims markdown delimiters', () => {
    const content = '[book](/api/file/book(1).epub)';

    expect(extractAttachmentPathsFromContent(content)).toEqual(['/api/file/book(1).epub']);
  });
});
