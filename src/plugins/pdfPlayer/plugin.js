import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';

import { PluginType } from 'constants/pluginType';

import loading from '../../components/loading/loading';
import keyboardnavigation from '../../scripts/keyboardNavigation';
import dialogHelper from '../../components/dialogHelper/dialogHelper';
import { appRouter } from '../../components/router/appRouter';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { translateHtml } from '../../lib/globalize';
import screenSaverManager from 'scripts/screensavermanager';
import * as userSettings from '../../scripts/settings/userSettings';
import Events from '../../utils/events.ts';
import BookOsd from '../bookPlayer/BookOsd/BookOsd';
import { renderComponent } from '../../utils/reactUtils';
import PdfDetailRenderer from './detailRenderer';
import PdfGestures from './gestures';

import 'material-design-icons-iconfont';
import html from './template.html';
import './style.scss';

const SETTINGS_KEY = 'pdfPlayer';
const MODES = ['flip', 'scroll'];
const FITS = ['page-fit', 'page-width'];
const SPREADS = ['auto', 'single', 'double'];
const DEFAULT_SETTINGS = {
    mode: MODES[0],
    fit: FITS[0],
    spread: SPREADS[0]
};

// pdf.js renders one page ahead, these pages around the visible ones are rendered as well
const PRELOAD_PAGES = 2;
// rendered pages further away from the visible ones are released to bound memory use
const KEEP_PAGES = PRELOAD_PAGES;
// zoom limits relative to the fitted page
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const DOUBLE_TAP_ZOOM = 2.5;
// pdf.js accepts scales up to 10
const MAX_SCALE = 10;
// share of the width at both sides where a tap turns the page
const TAP_ZONE = 0.3;
const SCROLL_PROGRESS_DELAY = 1000;
const RESIZE_DELAY = 150;
const WHEEL_GESTURE_GAP = 250;
// pdf.js TextLayerMode.DISABLE, text selection would interfere with the touch gestures
const TEXT_LAYER_DISABLED = 0;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function loadSettings() {
    let settings = {};
    try {
        settings = JSON.parse(userSettings.get(SETTINGS_KEY, false) || '{}') || {};
    } catch (err) {
        console.warn('[PdfPlayer] invalid settings', err);
    }

    return {
        mode: MODES.includes(settings.mode) ? settings.mode : DEFAULT_SETTINGS.mode,
        fit: FITS.includes(settings.fit) ? settings.fit : DEFAULT_SETTINGS.fit,
        spread: SPREADS.includes(settings.spread) ? settings.spread : DEFAULT_SETTINGS.spread
    };
}

export class PdfPlayer {
    constructor() {
        this.name = 'PDF Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'pdfplayer';
        this.priority = 1;

        this.onDialogClosed = this.onDialogClosed.bind(this);
        this.onWindowKeyDown = this.onWindowKeyDown.bind(this);
        this.onPagesInit = this.onPagesInit.bind(this);
        this.onPageChanging = this.onPageChanging.bind(this);
        this.onPageRendered = this.onPageRendered.bind(this);
        this.onScaleChanging = this.onScaleChanging.bind(this);
        this.onUpdateViewArea = this.onUpdateViewArea.bind(this);
        this.onScroll = this.onScroll.bind(this);
        this.onResize = this.onResize.bind(this);
        this.onTap = this.onTap.bind(this);
        this.onDoubleTap = this.onDoubleTap.bind(this);
        this.onSwipe = this.onSwipe.bind(this);
        this.onPinchStart = this.onPinchStart.bind(this);
        this.onPinchMove = this.onPinchMove.bind(this);
        this.onPinchEnd = this.onPinchEnd.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.toggleFullscreen = this.toggleFullscreen.bind(this);
        this.next = this.next.bind(this);
        this.previous = this.previous.bind(this);
    }

    play(options) {
        this.progress = 0;
        this.numPages = 0;
        this.loaded = false;
        this.cancellationToken = false;
        this.settings = loadSettings();
        this.fitScale = 0;
        this.visibleRange = null;

        screenSaverManager.block();
        loading.show();

        const elem = this.createMediaElement(options);
        return this.setCurrentSrc(elem, options);
    }

    stop() {
        this.unbindEvents();
        this.unmountBookOsd?.();
        this.unmountBookOsd = null;
        screenSaverManager.unblock();

        const stopInfo = {
            src: this.item
        };

        Events.trigger(this, 'stopped', [stopInfo]);

        const elem = this.mediaElement;
        if (elem) {
            dialogHelper.close(elem);
            this.mediaElement = null;
        }

        // hide loading animation
        loading.hide();

        // cancel page render
        this.cancellationToken = true;
        this.destroyViewer();
    }

    destroy() {
        // Nothing to do here
    }

    destroyViewer() {
        clearTimeout(this.progressTimeout);
        clearTimeout(this.resizeTimeout);

        window.removeEventListener('resize', this.onResize);
        this.gestures?.destroy();
        this.gestures = null;
        this.pinch = null;
        this.detailRenderer?.destroy();
        this.detailRenderer = null;

        if (this.container) {
            this.container.removeEventListener('scroll', this.onScroll);
            this.container = null;
        }

        if (this.pdfViewer) {
            this.pdfViewer.setDocument(null);
            this.linkService.setDocument(null);
            this.pdfViewer = null;
            this.linkService = null;
            this.eventBus = null;
        }

        // release the document and its worker
        this.loadingTask?.destroy();
        this.loadingTask = null;
        this.book = null;
        this.loaded = false;
    }

    currentItem() {
        return this.item;
    }

    currentTime() {
        return this.progress;
    }

    duration() {
        return this.numPages || 0;
    }

    volume() {
        return 100;
    }

    isMuted() {
        return false;
    }

    paused() {
        return false;
    }

    seekable() {
        return true;
    }

    onWindowKeyDown(e) {
        if (!this.loaded) return;

        // Skip modified keys
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

        // zoom keys are matched by the character they type, their position depends on the keyboard layout
        switch (e.key) {
            case '+':
            case '=':
                e.preventDefault();
                this.zoomBy(1.25);
                return;
            case '-':
                e.preventDefault();
                this.zoomBy(0.8);
                return;
            case '0':
                e.preventDefault();
                this.resetZoom();
                return;
        }

        const key = keyboardnavigation.getKeyName(e);

        switch (key) {
            case 'KeyL':
            case 'ArrowRight':
            case 'Right':
            case 'PageDown':
                e.preventDefault();
                this.next();
                break;
            case 'KeyJ':
            case 'ArrowLeft':
            case 'Left':
            case 'PageUp':
                e.preventDefault();
                this.previous();
                break;
            case 'Space':
                // a focused button is activated with the space key
                if (this.settings.mode === 'flip' && !e.target?.closest?.('button')) {
                    e.preventDefault();
                    this.next();
                }
                break;
            case 'Home':
                e.preventDefault();
                this.goToPage(1);
                break;
            case 'End':
                e.preventDefault();
                this.goToPage(this.numPages);
                break;
            case 'Escape':
                e.preventDefault();
                this.stop();
                break;
        }
    }

    onDialogClosed() {
        this.stop();
    }

    bindEvents() {
        this.mediaElement?.addEventListener('close', this.onDialogClosed, { once: true });
        document.addEventListener('keydown', this.onWindowKeyDown);
    }

    unbindEvents() {
        this.mediaElement?.removeEventListener('close', this.onDialogClosed);
        document.removeEventListener('keydown', this.onWindowKeyDown);
    }

    toggleFullscreen() {
        // the resize event lays out the pages again, this only covers browsers that resize late
        setTimeout(this.onResize, 200);
    }

    createMediaElement(options) {
        let elem = this.mediaElement;
        if (elem) {
            return elem;
        }

        elem = document.getElementById('pdfPlayer');
        if (!elem) {
            elem = dialogHelper.createDialog({
                exitAnimationDuration: 400,
                size: 'fullscreen',
                autoFocus: false,
                scrollY: false,
                exitAnimation: 'fadeout',
                removeOnClose: true
            });

            elem.id = 'pdfPlayer';
            elem.innerHTML = translateHtml(html);

            dialogHelper.open(elem);
        }

        this.mediaElement = elem;
        // the gestures decide whether a tap toggles the controls or turns the page
        this.osdRef = { current: null };
        this.unmountBookOsd = renderComponent(BookOsd, {
            item: options.items[0],
            osdRef: this.osdRef,
            disableClickToggle: true,
            onExit: this.onDialogClosed,
            onPrevious: this.previous,
            onNext: this.next,
            onToggleFullscreen: this.toggleFullscreen
        }, elem.querySelector('.pdfPlayerOsd'));

        return elem;
    }

    setCurrentSrc(elem, options) {
        const item = options.items[0];

        this.item = item;
        this.streamInfo = {
            started: true,
            ended: false,
            item: this.item,
            mediaSource: {
                Id: item.Id
            }
        };

        return import('pdfjs-dist').then(pdfjs => {
            // the viewer components look up the pdf.js API on the global object
            globalThis.pdfjsLib = pdfjs;
            return import('pdfjs-dist/web/pdf_viewer').then(pdfjsViewer => {
                if (this.cancellationToken) return;

                const api = ServerConnections.getApi(item.ServerId);
                if (!api) {
                    console.error('[PdfPlayer] no Api instance available for server', item.ServerId);
                    return;
                }

                this.pdfjs = pdfjs;
                this.pdfjsViewer = pdfjsViewer;

                const downloadHref = getLibraryApi(api).getDownloadUrl({ itemId: item.Id });

                pdfjs.GlobalWorkerOptions.workerSrc = appRouter.baseUrl() + '/libraries/pdf.worker.js';
                this.createViewer(elem);
                this.bindEvents();

                this.loadingTask = pdfjs.getDocument({
                    url: downloadHref,
                    // Disable for PDF.js XSS vulnerability
                    // https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq
                    isEvalSupported: false,
                    // only load the parts of large files that are needed (if the server supports range requests)
                    disableAutoFetch: true,
                    disableStream: true
                });
                return this.loadingTask.promise.then(book => {
                    if (this.cancellationToken) return;
                    this.currentSrc = () => downloadHref;
                    this.book = book;
                    this.numPages = book.numPages;

                    // the position is stored as page index
                    const startIndex = Math.floor((options.startPositionTicks || 0) / 10000);
                    this.progress = clamp(startIndex, 0, book.numPages - 1);

                    this.pdfViewer.setDocument(book);
                    this.linkService.setDocument(book);
                });
            });
        }).catch(err => {
            if (this.cancellationToken) return;
            loading.hide();
            console.error('[PdfPlayer] failed to load document', err);
            throw err;
        });
    }

    createViewer(elem) {
        const { EventBus, LinkTarget, PDFLinkService, PDFViewer, RenderingStates } = this.pdfjsViewer;
        const { AnnotationEditorType, AnnotationMode } = this.pdfjs;

        const container = elem.querySelector('.pdfPlayerContainer');
        this.container = container;
        this.viewerElement = container.querySelector('.pdfViewer');

        this.eventBus = new EventBus();
        this.linkService = new PDFLinkService({
            eventBus: this.eventBus,
            externalLinkTarget: LinkTarget.BLANK,
            externalLinkRel: 'noopener noreferrer nofollow',
            // links keep the zoom chosen by the user
            ignoreDestinationZoom: true
        });
        this.pdfViewer = new PDFViewer({
            container,
            viewer: this.viewerElement,
            eventBus: this.eventBus,
            linkService: this.linkService,
            removePageBorders: true,
            textLayerMode: TEXT_LAYER_DISABLED,
            annotationMode: AnnotationMode.ENABLE,
            // no annotation editing, its cleanup also fails in this pdf.js version
            annotationEditorMode: AnnotationEditorType.DISABLE
        });
        this.linkService.setViewer(this.pdfViewer);
        this.extendRenderingQueue();

        this.eventBus.on('pagesinit', this.onPagesInit);
        this.eventBus.on('pagechanging', this.onPageChanging);
        this.eventBus.on('pagerendered', this.onPageRendered);
        this.eventBus.on('scalechanging', this.onScaleChanging);
        this.eventBus.on('updateviewarea', this.onUpdateViewArea);

        this.detailRenderer = new PdfDetailRenderer(this.pdfViewer, container, {
            annotationMode: AnnotationMode.ENABLE,
            finishedState: RenderingStates.FINISHED
        });

        this.gestures = new PdfGestures(container, {
            onTap: this.onTap,
            onDoubleTap: this.onDoubleTap,
            onSwipe: this.onSwipe,
            onPinchStart: this.onPinchStart,
            onPinchMove: this.onPinchMove,
            onPinchEnd: this.onPinchEnd,
            onWheel: this.onWheel
        });

        container.addEventListener('scroll', this.onScroll, { passive: true });
        // the container covers the whole window
        window.addEventListener('resize', this.onResize);
    }

    /**
     * pdf.js only pre-renders the next page in scroll direction.
     * Render the pages on both sides of the visible ones as well, so turning pages back and forth is instant.
     */
    extendRenderingQueue() {
        const queue = this.pdfViewer.renderingQueue;
        const getHighestPriority = queue.getHighestPriority.bind(queue);

        queue.getHighestPriority = (visible, views, scrolledDown, preRenderExtra) => {
            if (visible.first) {
                this.visibleRange = { first: visible.first.id, last: visible.last.id };
            }

            const view = getHighestPriority(visible, views, scrolledDown, preRenderExtra);
            if (view || !this.visibleRange) return view;

            const { first, last } = this.visibleRange;
            for (let distance = 1; distance <= PRELOAD_PAGES; distance++) {
                const ids = scrolledDown ? [last + distance, first - distance] : [first - distance, last + distance];
                for (const id of ids) {
                    const candidate = views[id - 1];
                    if (candidate && !queue.isViewFinished(candidate)) return candidate;
                }
            }

            return null;
        };
    }

    /**
     * Release the canvases of pages far away from the visible ones, pdf.js keeps up to 10 rendered pages otherwise.
     * This includes pages whose rendering was paused when the user moved on.
     */
    releaseDistantPages() {
        if (!this.visibleRange || !this.pdfViewer) return;

        const { RenderingStates } = this.pdfjsViewer;
        const { first, last } = this.visibleRange;

        for (let pageNumber = 1; pageNumber <= this.pdfViewer.pagesCount; pageNumber++) {
            if (pageNumber >= first - KEEP_PAGES && pageNumber <= last + KEEP_PAGES) continue;

            const pageView = this.pdfViewer.getPageView(pageNumber - 1);
            if (pageView && pageView.renderingState !== RenderingStates.INITIAL) {
                pageView.destroy();
            }
        }
    }

    onPagesInit() {
        if (this.cancellationToken) return;

        const firstPage = this.pdfViewer.getPageView(0);
        this.portraitPages = !firstPage || firstPage.viewport.width <= firstPage.viewport.height;

        this.applyLayout();
        this.goToPage(this.progress + 1);
        this.loaded = true;

        this.container.focus({ preventScroll: true });
    }

    onPageChanging(e) {
        if (!this.loaded) return;

        const progress = e.pageNumber - 1;
        if (progress === this.progress) return;
        this.progress = progress;

        // report the new position, while scrolling only once the page settled
        clearTimeout(this.progressTimeout);
        if (this.settings.mode === 'scroll') {
            this.progressTimeout = setTimeout(() => Events.trigger(this, 'pause'), SCROLL_PROGRESS_DELAY);
        } else {
            Events.trigger(this, 'pause');
        }
    }

    onPageRendered() {
        loading.hide();

        this.releaseDistantPages();
        this.detailRenderer?.schedule();
    }

    onScaleChanging(e) {
        if (e.presetValue && FITS.includes(e.presetValue)) {
            this.fitScale = e.scale;
        }

        this.detailRenderer?.clear();
    }

    onUpdateViewArea() {
        this.releaseDistantPages();
    }

    onScroll() {
        this.detailRenderer?.schedule();
    }

    onResize() {
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
            if (!this.loaded || !this.pdfViewer) return;

            // mobile browsers resize the viewport when their toolbars show or hide, keep the zoom then
            const width = this.container.clientWidth;
            if (width === this.layoutWidth && this.isZoomed()) {
                this.pdfViewer.update();
                return;
            }

            this.applyLayout();
        }, RESIZE_DELAY);
    }

    useSpread() {
        switch (this.settings.spread) {
            case 'single':
                return false;
            case 'double':
                return true;
            default:
                // two pages side by side in landscape, unless the pages are landscape themselves
                return this.portraitPages && this.container.clientWidth > this.container.clientHeight;
        }
    }

    applyLayout() {
        const { ScrollMode, SpreadMode } = this.pdfjsViewer;
        const pdfViewer = this.pdfViewer;

        const scrollMode = this.settings.mode === 'scroll' ? ScrollMode.VERTICAL : ScrollMode.PAGE;
        if (pdfViewer.scrollMode !== scrollMode) {
            pdfViewer.scrollMode = scrollMode;
        }

        // SpreadMode.EVEN starts the spreads with an even page, the cover page is shown alone
        const spreadMode = this.useSpread() ? SpreadMode.EVEN : SpreadMode.NONE;
        if (pdfViewer.spreadMode !== spreadMode) {
            pdfViewer.spreadMode = spreadMode;
        }

        this.container.classList.toggle('pdfPlayerFlip', this.settings.mode === 'flip');
        this.layoutWidth = this.container.clientWidth;
        this.resetZoom();
    }

    goToPage(pageNumber) {
        if (!this.pdfViewer?.pdfDocument) return;
        this.pdfViewer.currentPageNumber = clamp(pageNumber, 1, this.numPages);
    }

    next() {
        if (!this.loaded) return;
        this.pdfViewer.nextPage();
    }

    previous() {
        if (!this.loaded) return;
        this.pdfViewer.previousPage();
    }

    getFitScale() {
        return this.fitScale || this.pdfViewer.currentScale;
    }

    isZoomed() {
        return this.pdfViewer.currentScale > this.getFitScale() * 1.01;
    }

    resetZoom() {
        if (!this.pdfViewer?.pdfDocument) return;
        this.pdfViewer.currentScaleValue = this.settings.fit;
    }

    /**
     * Find the point of the page below the given screen coordinates, as fraction of the page size.
     */
    getAnchor(x, y) {
        const pdfViewer = this.pdfViewer;
        const current = pdfViewer.currentPageNumber;
        let best = null;

        for (let pageNumber = Math.max(1, current - 2); pageNumber <= Math.min(this.numPages, current + 2); pageNumber++) {
            const div = pdfViewer.getPageView(pageNumber - 1)?.div;
            if (!div?.isConnected) continue;

            const rect = div.getBoundingClientRect();
            const distance = Math.hypot(
                Math.max(rect.left - x, 0, x - rect.right),
                Math.max(rect.top - y, 0, y - rect.bottom)
            );
            if (!best || distance < best.distance) {
                best = {
                    pageNumber,
                    distance,
                    fx: (x - rect.left) / rect.width,
                    fy: (y - rect.top) / rect.height
                };
            }
        }

        return best;
    }

    /**
     * Scroll so that the anchor ends up below the given screen coordinates again.
     */
    restoreAnchor(anchor, x, y) {
        if (!anchor) return;

        const div = this.pdfViewer.getPageView(anchor.pageNumber - 1)?.div;
        if (!div?.isConnected) return;

        const rect = div.getBoundingClientRect();
        this.container.scrollLeft += rect.left + anchor.fx * rect.width - x;
        this.container.scrollTop += rect.top + anchor.fy * rect.height - y;
    }

    /**
     * Zoom to the given scale keeping the anchor in place. Scales close to the fitted page snap back to fit mode.
     */
    zoomTo(scale, anchor, x, y) {
        const fitScale = this.getFitScale();
        const newScale = clamp(scale, fitScale, Math.min(fitScale * MAX_ZOOM, MAX_SCALE));

        if (newScale <= fitScale * 1.02) {
            this.resetZoom();
        } else {
            this.pdfViewer.currentScale = newScale;
        }

        this.restoreAnchor(anchor, x, y);
    }

    zoomBy(factor) {
        if (!this.loaded) return;

        const rect = this.container.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        this.zoomTo(this.pdfViewer.currentScale * factor, this.getAnchor(x, y), x, y);
    }

    onTap(x) {
        if (!this.loaded) return;

        if (this.settings.mode === 'flip') {
            const rect = this.container.getBoundingClientRect();
            const position = (x - rect.left) / rect.width;

            if (position < TAP_ZONE) {
                this.previous();
                return;
            }
            if (position > 1 - TAP_ZONE) {
                this.next();
                return;
            }
        }

        this.osdRef?.current?.toggle();
    }

    onDoubleTap(x, y) {
        if (!this.loaded) return;

        const anchor = this.getAnchor(x, y);
        if (this.isZoomed()) {
            this.zoomTo(this.getFitScale(), anchor, x, y);
        } else {
            this.zoomTo(this.getFitScale() * DOUBLE_TAP_ZOOM, anchor, x, y);
        }
    }

    onSwipe(direction, start) {
        if (!this.loaded || this.settings.mode !== 'flip') return;

        // a zoomed page is panned first, the page turns once its edge is reached
        if (direction === 'left' && start.scrollLeft >= start.maxScrollLeft - 2) {
            this.next();
        } else if (direction === 'right' && start.scrollLeft <= 2) {
            this.previous();
        }
    }

    onPinchStart(x, y) {
        if (!this.loaded) return;

        const rect = this.viewerElement.getBoundingClientRect();
        this.pinch = {
            anchor: this.getAnchor(x, y),
            x,
            y,
            scale: this.pdfViewer.currentScale
        };
        this.viewerElement.style.transformOrigin = `${x - rect.left}px ${y - rect.top}px`;
    }

    onPinchMove(scale, x, y) {
        const pinch = this.pinch;
        if (!pinch) return;

        // preview with a CSS transform, the pages are rendered again once the gesture ends
        const fitScale = this.getFitScale();
        const minScale = fitScale * MIN_ZOOM / pinch.scale;
        const maxScale = Math.min(fitScale * MAX_ZOOM, MAX_SCALE) / pinch.scale;
        const previewScale = clamp(scale, minScale, maxScale);
        this.viewerElement.style.transform = `translate(${x - pinch.x}px, ${y - pinch.y}px) scale(${previewScale})`;
    }

    onPinchEnd(scale, x, y) {
        const pinch = this.pinch;
        if (!pinch) return;
        this.pinch = null;

        this.viewerElement.style.transform = '';
        this.viewerElement.style.transformOrigin = '';
        this.zoomTo(pinch.scale * scale, pinch.anchor, x, y);
    }

    onWheel(e) {
        if (!this.loaded || this.settings.mode !== 'flip') return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;

        // turn the page with the mouse wheel once the page is scrolled to its end
        const container = this.container;
        const atTop = container.scrollTop <= 0;
        const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
        if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;

        e.preventDefault();

        // one page per wheel gesture, touchpads keep sending events for a while
        const now = Date.now();
        const newGesture = now - (this.lastWheelTime || 0) > WHEEL_GESTURE_GAP;
        this.lastWheelTime = now;
        if (!newGesture) return;

        if (e.deltaY > 0) {
            this.next();
        } else {
            this.previous();
        }
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'book';
    }

    canPlayItem(item) {
        return item.Path ? item.Path.toLowerCase().endsWith('pdf') : false;
    }
}

export default PdfPlayer;
