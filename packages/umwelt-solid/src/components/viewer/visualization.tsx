import { createEffect, createSignal, onCleanup } from 'solid-js';
import { umweltToVegaLiteSpec } from '../../util/spec';
import { UmweltDataset, UmweltSpec } from '../../types';
import { renderVegaLite } from '../../util/vega';
import { debounce } from '@solid-primitives/scheduled';
import { useUmweltSelection } from '../../contexts/UmweltSelectionContext';
import { predicateToSelectionStore, selectionStoreToSelection, VlSelectionStore } from '../../util/selection';

export type VisualizationProps = {
  spec: UmweltSpec;
  data: UmweltDataset;
};

export function Visualization(props: VisualizationProps) {
  const [umweltSelection, umweltSelectionActions] = useUmweltSelection();
  const [isMouseOver, setIsMouseOver] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const onSelectionStore = debounce((store: VlSelectionStore) => {
    // Update the selection when the brush store changes
    if (isMouseOver()) {
      const predicate = selectionStoreToSelection(store);
      umweltSelectionActions.setSelection({ source: 'visualization', predicate });
    }
  }, 250);

  const getContainerWidth = () => {
    if (!containerRef) return 600;
    const parentWidth = (containerRef.parentElement?.clientWidth || 800) * 0.8;
    return Math.max(parentWidth, 420);
  };

  createEffect(() => {
    // Update the view when the selection changes
    const sel = umweltSelection();
    const view = (window as any).view;
    if (!sel) {
      if (view) {
        view.data('external_state_store', undefined).run();
      }
      return;
    }

    if (!view) return;

    if (sel.source === 'sonification' || sel.source === 'text-navigation') {
      if (sel.predicate) {
        const store = predicateToSelectionStore(sel.predicate);
        view.data('external_state_store', store).run();
      } else {
        view.data('external_state_store', undefined).run();
      }
    }
  });

  createEffect(() => {
    const vlSpec = umweltToVegaLiteSpec(props.spec, props.data);

    if (vlSpec) {
      try {
        const width = getContainerWidth();
        const specWithSize = {
          ...vlSpec,
          width,
          height: width,
        };
        const view = renderVegaLite(specWithSize, '#vl-container');

        view.addDataListener('brush_store', (_: any, value: VlSelectionStore) => {
          onSelectionStore(value);
        });

        (window as any).view = view;
      } catch (e) {
        console.error(e);
      }
    }
    onCleanup(() => {
      (window as any).view?.finalize();
      (window as any).view = null;
      document.getElementById('vl-container')!.innerHTML = '';
    });
  });

  const onMouseEnter = () => {
    setIsMouseOver(true);
  };
  const onMouseLeave = () => {
    setIsMouseOver(false);
  };

  return (
    <div
      ref={containerRef}
      id="vl-container"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}

    ></div>
  );
}
