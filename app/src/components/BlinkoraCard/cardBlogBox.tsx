import { Image } from '@heroui/react';
import { Note } from '@shared/lib/types';
import { helper } from '@/lib/helper';
import { RootStore } from '@/store/root';
import { useNavigate } from 'react-router-dom';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { useEffect, useRef, useState, useMemo } from 'react';

interface BlogContentProps {
  blinkoraItem: Note & {
    isBlog?: boolean;
    title?: string;
  };
  isExpanded?: boolean;
}

const gradientPairs: [string, string][] = [
  ['#FF6B6B', '#4ECDC4'],
  ['#764BA2', '#667EEA'],
  ['#2E3192', '#1BFFFF'],
  ['#6B73FF', '#000DFF'],
  ['#FC466B', '#3F5EFB'],
  ['#11998E', '#38EF7D'],
  ['#536976', '#292E49'],
  ['#4776E6', '#8E54E9'],
  ['#1A2980', '#26D0CE'],
  ['#4B134F', '#C94B4B'],
];

export const CardBlogBox = ({ blinkoraItem, isExpanded }: BlogContentProps) => {
  const navigate = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number>(112);

  useEffect(() => {
    const updateHeight = () => {
      if (contentRef.current) {
        const height = contentRef.current.offsetHeight;
        setContentHeight(Math.max(100, height));
      }
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [blinkoraItem.content, blinkoraItem.title, blinkoraItem.tags]);

  return (
    <div className={`flex items-start gap-2 mt-4 w-full mb-4`}>
      <div
        ref={contentRef}
        className='blog-content flex flex-col pr-2'
        style={{
          width: '100%'
        }}
      >
        <div className={`font-bold mb-1 line-clamp-2 ${isExpanded ? 'text-lg' : 'text-md'}`}>
          {blinkoraItem.title?.replace(/#/g, '').replace(/\*/g, '')}
        </div>
        <div className={`text-desc flex-1 ${isExpanded ? 'text-sm' : 'text-sm'} line-clamp-4`}
        >
          {blinkoraItem.content?.replace(blinkoraItem.title ?? '', '').replace(/#/g, '').replace(/\*/g, '')}
        </div>
        {
          !!blinkoraItem?.tags?.length && blinkoraItem?.tags?.length > 0 && (
            <div className='flex flex-nowrap gap-1 overflow-x-scroll mt-1 hide-scrollbar'>
              {(() => {
                const tagTree = helper.buildHashTagTreeFromDb(
                  blinkoraItem.tags.map(tagItem => tagItem?.tag ?? tagItem)
                );
                const tagPaths = tagTree.flatMap(node => helper.generateTagPaths(node));
                const uniquePaths = tagPaths.filter(path => {
                  return !tagPaths.some(otherPath =>
                    otherPath !== path && otherPath.startsWith(path + '/')
                  );
                });
                return uniquePaths.map((path) => (
                  <div key={path} className='text-desc text-xs blinkora-tag whitespace-nowrap font-bold hover:opacity-80 !transition-all cursor-pointer' onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/?path=all&searchText=${encodeURIComponent("#" + path)}`)
                    RootStore.Get(BlinkoraStore).forceQuery++
                  }}>
                    #{path}
                  </div>
                ));
              })()}
            </div>
          )}
      </div>
    </div>
  );
};
