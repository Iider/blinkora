export function getBlinkoraEndpoint(path: string = ''): string {
  try {
    return new URL(path, window.location.origin).toString();
  } catch (error) {
    console.error(error);
    return new URL(path, window.location.origin).toString();
  }
}

export function withBlinkoraFileAccessToken(path: string = '', token?: string, workspaceId?: number): string {
  if (!path || !token || typeof window === 'undefined') return path;
  if (path.startsWith('blob:') || path.startsWith('data:')) return path;

  try {
    const url = new URL(path, window.location.origin);
    const isSameOrigin = url.origin === window.location.origin;
    const isProtectedFile = url.pathname.startsWith('/api/file/') || url.pathname.startsWith('/api/s3file/');
    if (!isSameOrigin || !isProtectedFile) return path;

    if (!url.searchParams.has('token')) {
      url.searchParams.set('token', token);
    }
    if (Number.isInteger(workspaceId) && Number(workspaceId) > 0) {
      url.searchParams.set('workspaceId', String(workspaceId));
    }
    return url.toString();
  } catch (error) {
    console.error(error);
    return path;
  }
}

export function withoutBlinkoraFileAccessToken(path: string = ''): string {
  if (!path || typeof window === 'undefined') return path;
  if (path.startsWith('blob:') || path.startsWith('data:')) return path;

  try {
    const url = new URL(path, window.location.origin);
    const isSameOrigin = url.origin === window.location.origin;
    const isProtectedFile = url.pathname.startsWith('/api/file/') || url.pathname.startsWith('/api/s3file/');
    if (!isSameOrigin || !isProtectedFile) return path;

    url.searchParams.delete('token');
    url.searchParams.delete('workspaceId');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    console.error(error);
    return path;
  }
}

export function stripBlinkoraFileAccessTokensFromText(text: string = ''): string {
  if (!text || typeof window === 'undefined') return text;
  return text.replace(
    /(https?:\/\/[^)\s"'<>]+\/api\/(?:file|s3file)\/[^)\s"'<>]+|\/api\/(?:file|s3file)\/[^)\s"'<>]+)/g,
    (value) => withoutBlinkoraFileAccessToken(value),
  );
}
