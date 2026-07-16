import { createTRPCClient, httpBatchLink, httpLink, splitLink, httpBatchStreamLink } from '@trpc/client';
import superjson from 'superjson';
import { getBlinkoraEndpoint } from './blinkoraEndpoint';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';
import { WorkspaceStore } from '@/store/workspace';
import type { BlinkoraTrpcClient } from './trpcContract';

const fetchWithTimeout: typeof fetch = (url, options) => {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });
};

const headers = () => {
  const userStore = RootStore.Get(UserStore);
  const workspaceStore = RootStore.Get(WorkspaceStore);
  const token = userStore.token;
  const workspaceId = workspaceStore.workspaceId;
  const baseHeaders: Record<string, string> = {};

  if (token) {
    baseHeaders['Authorization'] = `Bearer ${token}`;
  }
  if (workspaceId) {
    baseHeaders['x-workspace-id'] = String(workspaceId);
  }

  return baseHeaders;
};


const getLinks = (useStream = false) => {
  try {
    if (useStream) {
      return httpBatchStreamLink({
        url: getBlinkoraEndpoint('/api/trpc'),
        transformer: superjson,
        headers,
        fetch: fetchWithTimeout
      });
    }

    return splitLink({
      condition(op) {
        return op.context.skipBatch === true;
      },
      true: httpLink({
        url: getBlinkoraEndpoint('/api/trpc'),
        transformer: superjson,
        headers,
        fetch: fetchWithTimeout
      }),
      false: httpBatchLink({
        url: getBlinkoraEndpoint('/api/trpc'),
        transformer: superjson,
        headers,
        fetch: fetchWithTimeout
      }),
    });
  } catch (error) {
    console.error(error, 'trpc get links error');
    return splitLink({
      condition(op) {
        return op.context.skipBatch === true;
      },
      true: httpLink({
        url: ('/api/trpc'),
        transformer: superjson,
        headers,
        fetch: fetchWithTimeout
      }),
      false: httpBatchLink({
        url: ('/api/trpc'),
        transformer: superjson,
        headers,
        fetch: fetchWithTimeout
      }),
    });
  }
};

const createClient = (useStream: boolean): BlinkoraTrpcClient => createTRPCClient({
  links: [getLinks(useStream)],
}) as unknown as BlinkoraTrpcClient;

export let api = createClient(false);

export let streamApi = createClient(true);

export const reinitializeTrpcApi = () => {
  api = createClient(false);
  streamApi = createClient(true);

  return { api, streamApi };
};
