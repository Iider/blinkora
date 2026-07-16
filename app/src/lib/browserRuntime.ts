import { useEffect, useState } from 'react';
import { RootStore } from '@/store';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { UserStore } from '@/store/user';
import { WorkspaceStore } from '@/store/workspace';
import { withBlinkoraFileAccessToken } from './blinkoraEndpoint';
import i18n from './i18n';

export interface PermissionStatus {
  audio: boolean;
  camera: boolean;
}

export async function downloadFromLink(uri: string, filename?: string) {
  try {
    const url = new URL(uri, window.location.origin);
    url.searchParams.set('download', 'true');

    const token = RootStore.Get(UserStore).tokenData.value?.token;
    const workspaceId = RootStore.Get(WorkspaceStore).workspaceId;

    const link = document.createElement('a');
    link.href = withBlinkoraFileAccessToken(url.toString(), token, workspaceId);
    if (filename) {
      link.download = filename;
    }
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    console.error('Download failed:', error);
    RootStore.Get(ToastPlugin).error(i18n.t('download-failed'));
  }
}

export const requestMicrophonePermission = async (): Promise<boolean> => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    stream.getTracks().forEach((track) => track.stop());
    localStorage.setItem('microphone_permission_granted', 'true');
    return true;
  } catch (error) {
    console.error('Failed to request microphone permission:', error);
    localStorage.removeItem('microphone_permission_granted');
    return false;
  }
};

export const checkMicrophonePermission = async (): Promise<boolean> => {
  try {
    if (localStorage.getItem('microphone_permission_granted') === 'true') {
      return true;
    }

    if ('permissions' in navigator) {
      try {
        const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (permission.state === 'granted') {
          localStorage.setItem('microphone_permission_granted', 'true');
          return true;
        }
        if (permission.state === 'denied') {
          localStorage.removeItem('microphone_permission_granted');
          return false;
        }
      } catch {}
    }

    return false;
  } catch (error) {
    console.error('Error checking microphone permission:', error);
    localStorage.removeItem('microphone_permission_granted');
    return false;
  }
};

export const usePermissions = () => {
  const [permissions, setPermissions] = useState<PermissionStatus>({
    audio: false,
    camera: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkPermissions = async () => {
      setLoading(true);

      try {
        const audioPermission = await checkMicrophonePermission();
        setPermissions({
          audio: audioPermission,
          camera: false,
        });
      } catch (error) {
        console.error('Error checking permissions:', error);
      } finally {
        setLoading(false);
      }
    };

    checkPermissions();
  }, []);

  const requestAudioPermission = async () => {
    const granted = await requestMicrophonePermission();
    setPermissions((prev) => ({ ...prev, audio: granted }));
    return granted;
  };

  return {
    permissions,
    loading,
    requestAudioPermission,
  };
};
