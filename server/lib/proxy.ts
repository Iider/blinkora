import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Context } from '@server/context';

export async function fetchWithProxy(): Promise<typeof fetch> {
  return fetch;
}

export async function createAxiosWithProxy(options?: { ctx?: Context; useAdmin?: boolean; baseConfig?: AxiosRequestConfig }): Promise<AxiosInstance> {
  const { baseConfig = {} } = options || {};
  return axios.create({
    ...baseConfig,
    timeout: baseConfig.timeout || 30000,
    validateStatus: () => true,
  });
}

export async function getWithProxy(
  url: string,
  options?: {
    ctx?: Context;
    useAdmin?: boolean;
    config?: AxiosRequestConfig;
  },
) {
  try {
    const { config = {} } = options || {};
    const axiosInstance = await createAxiosWithProxy(options);
    return await axiosInstance.get(url, config);
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return {
      error: true,
      data: null,
      status: (error as any)?.response?.status || 500,
      statusText: (error as any)?.response?.statusText || 'Error',
      message: safeError.message || 'Unknown error',
      proxyInfo: {},
      url,
    };
  }
}

export async function postWithProxy(
  url: string,
  data?: any,
  options?: {
    ctx?: Context;
    useAdmin?: boolean;
    config?: AxiosRequestConfig;
  },
) {
  try {
    const { config = {} } = options || {};
    const axiosInstance = await createAxiosWithProxy(options);
    return await axiosInstance.post(url, data, config);
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return {
      error: true,
      data: null,
      status: (error as any)?.response?.status || 500,
      statusText: (error as any)?.response?.statusText || 'Error',
      message: safeError.message || 'Unknown error',
      proxyInfo: {},
      url,
    };
  }
}

export async function getProxyUrl(): Promise<string | null> {
  return null;
}

export async function getHttpCacheKey(): Promise<string> {
  return 'no-http-proxy';
}
