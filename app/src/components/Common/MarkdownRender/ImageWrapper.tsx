import { Image } from '@heroui/react';
import { PhotoProvider, PhotoView } from 'react-photo-view';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';
import { withBlinkoraFileAccessToken } from '@/lib/blinkoraEndpoint';

interface ImageWrapperProps {
  src?: string;
  width?: number | string;
  height?: number | string;
  alt?: string;
}

export const ImageWrapper = ({ src = '', width, height, alt }: ImageWrapperProps) => {
  const props = { width, height, alt }
  if (!src) return null;
  const imageSrc = withBlinkoraFileAccessToken(src, RootStore.Get(UserStore).tokenData.value?.token);
  
  return (
    <div className='markdown-image-wrapper w-full'>
      <PhotoProvider>
        <PhotoView src={imageSrc} >
          <Image src={imageSrc} {...props}
            classNames={{
              wrapper: '!max-w-fit !m-auto',
            }} className='w-full max-h-[200px] object-cover' />
        </PhotoView>
      </PhotoProvider>
    </div>
  );
}; 
