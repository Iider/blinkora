import axios from 'axios';
import { RootStore } from '@/store/root';
import { UserStore } from '@/store/user';
import { WorkspaceStore } from '@/store/workspace';

// Create axios instance
const axiosInstance = axios.create({
  baseURL: '', // Base URL can be set as needed
  timeout: 5 * 60 * 1000, // 5 minutes for large file uploads
});

// Request interceptor
axiosInstance.interceptors.request.use(
  (config) => {
    // Get token from UserStore
    const userStore = RootStore.Get(UserStore);
    const workspaceStore = RootStore.Get(WorkspaceStore);
    const token = userStore.tokenData.value?.token;
    const workspaceId = workspaceStore.workspaceId;
    
    // If token exists, add it to request headers
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    if (workspaceId) {
      config.headers['x-workspace-id'] = String(workspaceId);
    }
    
    return config;
  },
  (error) => {
    console.error('[Client] Axios request error:', error);
    return Promise.reject(error);
  }
);

// Response interceptor
axiosInstance.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.error('[Client] Axios response error:', error);
    
    // Handle 401 error (unauthorized)
    if (error.response && error.response.status === 401) {
      // You can handle token expiration logic here, such as redirecting to login page
      // window.location.href = '/signin';
    }
    
    return Promise.reject(error);
  }
);

export default axiosInstance;
