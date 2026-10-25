import React, { type FC, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';

import IconButton from '../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import BookOsd, { type BookOsdHandle } from '../bookPlayer/BookOsd/BookOsd';

export interface PdfOsdSnapshot {
    mode: string;
    fit: string;
    spread: string;
    page: number;
    pageCount: number;
}

/** State the player shares with the controls, the player updates it and the controls render it. */
export class PdfOsdState {
    private snapshot: PdfOsdSnapshot;
    private readonly listeners = new Set<() => void>();

    constructor(snapshot: PdfOsdSnapshot) {
        this.snapshot = snapshot;
    }

    getSnapshot = () => this.snapshot;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    update(changes: Partial<PdfOsdSnapshot>) {
        this.snapshot = { ...this.snapshot, ...changes };
        for (const listener of this.listeners) {
            listener();
        }
    }
}

interface ButtonInfo {
    icon: string;
    title: string;
}

const MODE_BUTTONS: Record<string, ButtonInfo> = {
    'flip': { icon: 'auto_stories', title: 'PdfReaderPageByPage' },
    'scroll': { icon: 'view_day', title: 'PdfReaderContinuousScroll' }
};
const FIT_BUTTONS: Record<string, ButtonInfo> = {
    'page-fit': { icon: 'fit_screen', title: 'PdfReaderFitPage' },
    'page-width': { icon: 'width_full', title: 'PdfReaderFitWidth' }
};
const SPREAD_BUTTONS: Record<string, ButtonInfo> = {
    'auto': { icon: 'import_contacts', title: 'PdfReaderSpreadAuto' },
    'single': { icon: 'crop_portrait', title: 'PdfReaderSpreadSingle' },
    'double': { icon: 'menu_book', title: 'PdfReaderSpreadDouble' }
};

interface PageSliderProps {
    page: number;
    pageCount: number;
    osdRef: RefObject<BookOsdHandle>;
    onSeek: (page: number) => void;
}

const PageSlider: FC<PageSliderProps> = ({ page, pageCount, osdRef, onSeek }) => {
    const slider = useRef<HTMLInputElement>(null);
    // the page shown while the slider is moved, the player only turns the page once it is released
    const [preview, setPreview] = useState<number | null>(null);
    const value = preview ?? page;

    const onInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setPreview(parseInt(e.target.value, 10));
        osdRef.current?.show(false);
    }, [osdRef]);

    useEffect(() => {
        const element = slider.current;
        if (!element) return;

        // React maps onChange to the input event, the change event fires once the slider is released
        const onChange = () => {
            setPreview(null);
            onSeek(parseInt(element.value, 10));
            element.blur();
            osdRef.current?.show();
        };

        element.addEventListener('change', onChange);
        return () => element.removeEventListener('change', onChange);
    }, [onSeek, osdRef]);

    return (
        <>
            <input
                ref={slider}
                type='range'
                className='pdfPlayerSlider'
                min={1}
                max={Math.max(pageCount, 1)}
                step={1}
                value={value}
                onChange={onInput}
                title={globalize.translate('PdfReaderPageOf', value, pageCount)}
            />
            <span className='pdfPlayerPageLabel'>
                {pageCount ? globalize.translate('PdfReaderPageOf', value, pageCount) : ''}
            </span>
        </>
    );
};

interface PdfOsdProps {
    item: BaseItemDto;
    state: PdfOsdState;
    osdRef: RefObject<BookOsdHandle>;
    onExit: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onToggleFullscreen: () => void;
    onToggleMode: () => void;
    onToggleFit: () => void;
    onToggleSpread: () => void;
    onSeek: (page: number) => void;
}

/** BookOsd with the controls BookOsd has no equivalent for: layout settings and the page slider. */
const PdfOsd: FC<PdfOsdProps> = ({
    item,
    state,
    osdRef,
    onExit,
    onPrevious,
    onNext,
    onToggleFullscreen,
    onToggleMode,
    onToggleFit,
    onToggleSpread,
    onSeek
}) => {
    const { mode, fit, spread, page, pageCount } = useSyncExternalStore(state.subscribe, state.getSnapshot);

    const headerControls = (
        <>
            <IconButton
                onClick={onToggleMode}
                icon={MODE_BUTTONS[mode].icon}
                title={globalize.translate(MODE_BUTTONS[mode].title)}
            />
            <IconButton
                onClick={onToggleSpread}
                icon={SPREAD_BUTTONS[spread].icon}
                title={globalize.translate(SPREAD_BUTTONS[spread].title)}
            />
            <IconButton
                onClick={onToggleFit}
                icon={FIT_BUTTONS[fit].icon}
                title={globalize.translate(FIT_BUTTONS[fit].title)}
            />
        </>
    );

    return (
        <BookOsd
            item={item}
            osdRef={osdRef}
            disableClickToggle
            onExit={onExit}
            onPrevious={onPrevious}
            onNext={onNext}
            onToggleFullscreen={onToggleFullscreen}
            headerControls={headerControls}
            footerControls={
                <PageSlider page={page} pageCount={pageCount} osdRef={osdRef} onSeek={onSeek} />
            }
        />
    );
};

export default PdfOsd;
