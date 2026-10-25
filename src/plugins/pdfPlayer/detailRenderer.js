// pdf.js limits the size of a page canvas (maxCanvasPixels) to keep memory bounded, beyond that
// limit a zoomed page is only an upscaled bitmap. This renders the visible part of such pages
// again at full resolution on a small canvas on top of the page.

// share of the viewport that is rendered around the visible area
const MARGIN = 0.15;
const RENDER_DELAY = 150;
const MAX_PIXELS = 16777216;
const SHARP_ENOUGH = 0.95;
// pages around the current page that are checked
const PAGES_BEFORE = 2;
const PAGES_AFTER = 3;

export class PdfDetailRenderer {
    constructor(pdfViewer, container, { annotationMode, finishedState }) {
        this.pdfViewer = pdfViewer;
        this.container = container;
        this.annotationMode = annotationMode;
        this.finishedState = finishedState;
        this.details = new Map();
        this.timeout = null;
    }

    schedule() {
        clearTimeout(this.timeout);
        this.timeout = setTimeout(() => this.update(), RENDER_DELAY);
    }

    clear() {
        clearTimeout(this.timeout);
        for (const pageNumber of [...this.details.keys()]) {
            this.remove(pageNumber);
        }
    }

    destroy() {
        this.clear();
        this.pdfViewer = null;
    }

    remove(pageNumber) {
        const detail = this.details.get(pageNumber);
        if (!detail) return;

        detail.task?.cancel();
        releaseCanvas(detail.canvas);
        releaseCanvas(detail.previousCanvas);
        this.details.delete(pageNumber);
    }

    update() {
        const pdfViewer = this.pdfViewer;
        if (!pdfViewer?.pdfDocument) return;

        const outputScale = window.devicePixelRatio || 1;
        const containerRect = this.container.getBoundingClientRect();
        const first = Math.max(1, pdfViewer.currentPageNumber - PAGES_BEFORE);
        const last = Math.min(pdfViewer.pagesCount, pdfViewer.currentPageNumber + PAGES_AFTER);

        for (const pageNumber of [...this.details.keys()]) {
            if (pageNumber < first || pageNumber > last) {
                this.remove(pageNumber);
            }
        }

        for (let pageNumber = first; pageNumber <= last; pageNumber++) {
            this.updatePage(pageNumber, containerRect, outputScale);
        }
    }

    updatePage(pageNumber, containerRect, outputScale) {
        const pageView = this.pdfViewer.getPageView(pageNumber - 1);
        const canvas = pageView?.canvas;
        if (!canvas?.isConnected || pageView.renderingState !== this.finishedState) {
            this.remove(pageNumber);
            return;
        }

        const { viewport } = pageView;
        if (canvas.width >= viewport.width * outputScale * SHARP_ENOUGH) {
            // the page canvas itself is sharp
            this.remove(pageNumber);
            return;
        }

        const pageRect = pageView.div.getBoundingClientRect();
        if (Math.abs(pageRect.width - viewport.width) > 2) {
            // the page is transformed (e.g. during a pinch gesture)
            return;
        }

        const marginX = containerRect.width * MARGIN;
        const marginY = containerRect.height * MARGIN;
        const left = Math.max(pageRect.left, containerRect.left - marginX);
        const top = Math.max(pageRect.top, containerRect.top - marginY);
        const right = Math.min(pageRect.right, containerRect.right + marginX);
        const bottom = Math.min(pageRect.bottom, containerRect.bottom + marginY);
        if (right <= left || bottom <= top) {
            this.remove(pageNumber);
            return;
        }

        // area in CSS pixels relative to the page
        const x = Math.floor(left - pageRect.left);
        const y = Math.floor(top - pageRect.top);
        const width = Math.ceil(right - pageRect.left) - x;
        const height = Math.ceil(bottom - pageRect.top) - y;

        const existing = this.details.get(pageNumber);
        if (existing && covers(existing, viewport.scale, x, y, width, height)) return;

        let ratio = outputScale;
        if (width * height * ratio * ratio > MAX_PIXELS) {
            ratio = Math.sqrt(MAX_PIXELS / (width * height));
        }

        const detailCanvas = document.createElement('canvas');
        detailCanvas.className = 'pdfPlayerDetailCanvas';
        detailCanvas.width = Math.round(width * ratio);
        detailCanvas.height = Math.round(height * ratio);

        const detail = {
            canvas: detailCanvas,
            previousCanvas: null,
            rendered: false,
            scale: viewport.scale,
            x,
            y,
            width,
            height,
            task: null
        };

        if (existing) {
            // keep showing the old area until the new one is ready
            existing.task?.cancel();
            detail.previousCanvas = existing.rendered ? existing.canvas : existing.previousCanvas;
            if (existing.rendered) {
                releaseCanvas(existing.previousCanvas);
            } else {
                releaseCanvas(existing.canvas);
            }
        }

        detail.task = pageView.pdfPage.render({
            canvasContext: detailCanvas.getContext('2d', { alpha: false }),
            viewport: viewport.clone({ scale: viewport.scale * ratio }),
            transform: [1, 0, 0, 1, -x * ratio, -y * ratio],
            annotationMode: this.annotationMode
        });
        this.details.set(pageNumber, detail);

        detail.task.promise.then(() => {
            if (this.details.get(pageNumber) !== detail) return;

            detail.task = null;
            detail.rendered = true;

            const style = detailCanvas.style;
            style.left = `${x}px`;
            style.top = `${y}px`;
            style.width = `${width}px`;
            style.height = `${height}px`;
            canvas.parentNode?.append(detailCanvas);

            releaseCanvas(detail.previousCanvas);
            detail.previousCanvas = null;
        }).catch(err => {
            if (err?.name !== 'RenderingCancelledException') {
                console.warn('[PdfPlayer] failed to render page detail', err);
            }
        });
    }
}

function covers(detail, scale, x, y, width, height) {
    if (detail.scale !== scale) return false;
    if (detail.rendered && !detail.canvas.isConnected) return false;

    return detail.x <= x && detail.y <= y
        && detail.x + detail.width >= x + width
        && detail.y + detail.height >= y + height;
}

function releaseCanvas(canvas) {
    if (!canvas) return;

    canvas.remove();
    // free the bitmap right away, Safari keeps it alive otherwise
    canvas.width = 0;
    canvas.height = 0;
}

export default PdfDetailRenderer;
