import type { BlinkoraStore } from '@/store/blinkoraStore';

const SEARCH_FILTER_QUERY_KEYS = ['searchText', 'tagId', 'withoutTag', 'withFile', 'withLink', 'hasTodo'] as const;

export const clearSearchState = (blinkoraStore: BlinkoraStore) => {
  blinkoraStore.searchText = '';
  blinkoraStore.globalSearchTerm = '';
  blinkoraStore.noteListFilterConfig.tagId = null;
  blinkoraStore.noteListFilterConfig.withoutTag = false;
  blinkoraStore.noteListFilterConfig.withFile = false;
  blinkoraStore.noteListFilterConfig.withLink = false;
  blinkoraStore.noteListFilterConfig.hasTodo = false;
};

export const getSearchWithClearedFilters = (searchParams: URLSearchParams) => {
  const nextSearchParams = new URLSearchParams(searchParams);

  SEARCH_FILTER_QUERY_KEYS.forEach((key) => {
    nextSearchParams.delete(key);
  });

  const search = nextSearchParams.toString();
  return search ? `?${search}` : '';
};
