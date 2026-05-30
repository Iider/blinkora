const attachmentPathPattern = /\/api\/(?:s3)?file\/[^\s"'<>]+/g;

const normalizeAttachmentPath = (rawPath: string) => {
  const withoutQuery = rawPath.split(/[?#]/)[0];
  return withoutQuery.replace(/[)\],.;:!?]+$/g, '');
};

export const extractAttachmentPathsFromContent = (content?: string | null) => {
  if (!content) return [];
  return Array.from(
    new Set(
      (content.match(attachmentPathPattern) || [])
        .map(normalizeAttachmentPath)
        .filter(Boolean)
    )
  );
};
