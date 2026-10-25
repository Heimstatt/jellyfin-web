import React, { type FC, type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import './BookOsd.scss';
import IconButton from '../../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import * as userSettings from '../../../scripts/settings/userSettings';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';
import Screenfull from 'screenfull';

/** Lets a player show and hide the controls, e.g. when it handles taps itself. */
export interface BookOsdHandle {
    /** Show the controls, they hide again after a delay unless autoHide is false. */
    show: (autoHide?: boolean) => void;
    hide: () => void;
    toggle: () => void;
}

interface BookOsdProps {
    item: BaseItemDto;
    onExit: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onOpenTableOfContents?: () => void;
    onRotateTheme?: () => void;
    onDecreaseFontSize?: () => void;
    onIncreaseFontSize?: () => void;
    onToggleDirection?: () => void;
    onToggleLayout?: () => void;
    onToggleFullscreen: () => void;
    /** Additional controls at the end of the top row. */
    headerControls?: ReactNode;
    /** Additional controls in the bottom row, they take the free space between the navigation buttons and the other buttons. */
    footerControls?: ReactNode;
    osdRef?: Ref<BookOsdHandle>;
    /** The player toggles the controls itself (via osdRef), clicks outside of the controls don't. */
    disableClickToggle?: boolean;
}

interface ComicsPlayerSettings {
    langDir?: string;
    pagesPerView?: number;
}

const BookOsd: FC<BookOsdProps> = ({
    item,
    onExit,
    onPrevious,
    onNext,
    onOpenTableOfContents,
    onRotateTheme,
    onDecreaseFontSize,
    onIncreaseFontSize,
    onToggleDirection,
    onToggleLayout,
    onToggleFullscreen,
    headerControls,
    footerControls,
    osdRef,
    disableClickToggle = false
}) => {
    const settings = userSettings.getComicsPlayerSettings(item.Id!) as ComicsPlayerSettings;
    const timeout = useRef<ReturnType<typeof setTimeout>>();
    // read in the click listener without registering it again
    const clickToggle = useRef(!disableClickToggle);
    clickToggle.current = !disableClickToggle;

    const [direction, setDirection] = useState(settings.langDir === 'rtl');
    const [layout, setLayout] = useState(settings.pagesPerView === 2);
    const [fullscreen, setFullscreen] = useState(false);
    const [visible, setVisible] = useState(true);

    const scheduleHide = useCallback(() => {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setVisible(false), 2000);
    }, []);

    useImperativeHandle(osdRef, () => ({
        show: (autoHide = true) => {
            if (autoHide) {
                scheduleHide();
            } else {
                clearTimeout(timeout.current);
            }
            setVisible(true);
        },
        hide: () => {
            clearTimeout(timeout.current);
            setVisible(false);
        },
        toggle: () => {
            scheduleHide();
            setVisible(state => !state);
        }
    }), [scheduleHide]);

    const updateFullscreen = useCallback((state: boolean) => {
        if (Screenfull.isEnabled && Screenfull.isFullscreen !== state) {
            void Screenfull.toggle();
        } else if (window.NativeShell) {
            state ? window.NativeShell.enableFullscreen() : window.NativeShell.disableFullscreen();
        }
    }, []);

    const onClickDirection = useCallback(() => {
        onToggleDirection?.();
        setDirection(state => !state);
    }, [onToggleDirection]);

    const onClickLayout = useCallback(() => {
        onToggleLayout?.();
        setLayout(state => !state);
    }, [onToggleLayout]);

    const onClickFullscreen = useCallback(() => {
        updateFullscreen(!fullscreen);
        onToggleFullscreen?.();
        setFullscreen(state => !state);
    }, [onToggleFullscreen, updateFullscreen, fullscreen]);

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse') return;

            scheduleHide();
            setVisible(true);
        };

        const onClick = (event: MouseEvent) => {
            // apply this before the BookOsd check so IconButton clicks will reset the timer
            scheduleHide();

            if (!clickToggle.current) return;
            if ((event.target as Element | null)?.closest?.('.bookOsdRow')) return;
            setVisible(state => !state);
        };

        scheduleHide();
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('click', onClick);

        return () => {
            clearTimeout(timeout.current);
            updateFullscreen(false);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('click', onClick);
        };
    }, [scheduleHide, updateFullscreen]);

    return (
        <div className='bookOsd'>
            <div className='bookOsdRow' style={{ paddingTop: 'env(safe-area-inset-top)', ...(!visible && { opacity: 0, pointerEvents: 'none' }) }}>
                <IconButton onClick={onExit} icon='arrow_back' title={globalize.translate('ButtonBack')} />
                <span className='bookOsdTitle'>{item.Name}</span>
                {headerControls && (
                    <>
                        <div className='bookOsdSpacer' />
                        {headerControls}
                    </>
                )}
            </div>

            <div className='bookOsdRow' style={{ paddingBottom: 'env(safe-area-inset-bottom)', ...(!visible && { opacity: 0, pointerEvents: 'none' }) }}>
                <IconButton onClick={onPrevious} icon='navigate_before' title={globalize.translate('Previous')} />
                <IconButton onClick={onNext} icon='navigate_next' title={globalize.translate('Next')} />
                {footerControls ? (
                    <div className='bookOsdControls'>{footerControls}</div>
                ) : (
                    <div className='bookOsdSpacer' />
                )}

                {onOpenTableOfContents && (
                    <IconButton
                        onClick={onOpenTableOfContents}
                        icon='toc'
                        title={globalize.translate('TableOfContents')}
                    />
                )}

                {onRotateTheme && (
                    <IconButton
                        onClick={onRotateTheme}
                        icon='remove_red_eye'
                        title={globalize.translate('LabelTheme')}
                    />
                )}

                {onDecreaseFontSize && (
                    <IconButton
                        onClick={onDecreaseFontSize}
                        icon='text_decrease'
                        title={globalize.translate('Smaller')}
                    />
                )}

                {onIncreaseFontSize && (
                    <IconButton
                        onClick={onIncreaseFontSize}
                        icon='text_increase'
                        title={globalize.translate('Larger')}
                    />
                )}

                {onToggleDirection && (
                    <IconButton
                        onClick={onClickDirection}
                        icon={direction ? 'arrow_circle_left' : 'arrow_circle_right'}
                        title={globalize.translate(direction ? 'ViewRightToLeft' : 'ViewLeftToRight')}
                    />
                )}

                {onToggleLayout && (
                    <IconButton
                        onClick={onClickLayout}
                        icon={layout ? 'import_contacts' : 'devices_fold'}
                        title={globalize.translate(layout ? 'ViewDoublePage' : 'ViewSinglePage')}
                    />
                )}

                {(Screenfull.isEnabled || window.NativeShell) && (
                    <IconButton
                        onClick={onClickFullscreen}
                        icon={fullscreen ? 'fullscreen_exit' : 'fullscreen'}
                        title={globalize.translate(fullscreen ? 'ExitFullscreen' : 'Fullscreen')}
                    />
                )}
            </div>
        </div>
    );
};

export default BookOsd;
