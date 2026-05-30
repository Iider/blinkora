import { ScrollArea } from "@/components/Common/ScrollArea";
import { RootStore } from "@/store";
import { BlinkoraStore } from "@/store/blinkoraStore";
import { _ } from "@/lib/lodash";
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useLocation, useSearchParams } from 'react-router-dom';
import { BlinkoraCard } from "@/components/BlinkoraCard";
import { LoadingAndEmpty } from "@/components/Common/LoadingAndEmpty";

const Detail = observer(() => {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const blinkora = RootStore.Get(BlinkoraStore);

  useEffect(() => {
    if (searchParams.get('id')) {
      blinkora.noteDetail.call({ id: Number(searchParams.get('id')) });
    }
  }, [location.pathname, searchParams.get('id'), blinkora.updateTicker, blinkora.forceQuery]);

  return (
    <ScrollArea fixMobileTopBar>
      <div className="max-w-[800px] mx-auto p-4">
        <LoadingAndEmpty
          isLoading={blinkora.noteDetail.loading.value}
          isEmpty={!blinkora.noteDetail.value}
        />

        {blinkora.noteDetail.value && (
          <BlinkoraCard
            blinkoraItem={blinkora.noteDetail.value}
            defaultExpanded={false}
            glassEffect={false}
          />
        )}
      </div>
    </ScrollArea>
  );
});

export default Detail;