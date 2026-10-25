// Page overview for the PDF player. Thumbnails are rendered lazily one after another while the
// overview is open and kept as small JPEG images instead of canvases to keep memory low.

const THUMBNAIL_WIDTH = 160;
const MAX_OUTPUT_SCALE = 2;
const JPEG_QUALITY = 0.8;

function canvasToUrl(canvas) {
    return new Promise(resolve => {
        if (!canvas.toBlob) {
            resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
            return;
        }

        canvas.toBlob(blob => {
            resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/jpeg', JPEG_QUALITY));
        }, 'image/jpeg', JPEG_QUALITY);
    });
}

export class PdfThumbnails {
    constructor(element, book, onSelect) {
        this.element = element;
        this.grid = element.querySelector('.pdfPlayerThumbnailGrid');
        this.book = book;
        this.onSelect = onSelect;
        this.opened = false;
        this.destroyed = false;
        this.rendering = false;
        this.queue = new Set();
        this.rendered = new Set();
        this.urls = [];
        this.items = [];
        this.currentPage = 0;

        this.onGridClick = this.onGridClick.bind(this);
        this.onIntersection = this.onIntersection.bind(this);
    }

    isOpen() {
        return this.opened;
    }

    open(currentPage) {
        this.opened = true;
        this.element.classList.remove('hide');

        const ready = this.buildPromise || (this.buildPromise = this.build());
        return ready.then(() => {
            if (!this.opened) return;

            this.setCurrentPage(currentPage);
            this.items[currentPage - 1]?.scrollIntoView({ block: 'center' });
            this.items[currentPage - 1]?.focus({ preventScroll: true });
            this.processQueue();
        });
    }

    close() {
        this.opened = false;
        this.element.classList.add('hide');
    }

    destroy() {
        this.close();
        this.destroyed = true;
        this.observer?.disconnect();
        this.grid.removeEventListener('click', this.onGridClick);
        this.grid.innerHTML = '';

        for (const url of this.urls) {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        }

        this.urls = [];
        this.items = [];
        this.queue.clear();
        this.book = null;
    }

    build() {
        return this.book.getPage(1).then(page => {
            if (this.destroyed) return;

            const viewport = page.getViewport({ scale: 1 });
            const aspectRatio = `${viewport.width} / ${viewport.height}`;
            const fragment = document.createDocumentFragment();

            for (let pageNumber = 1; pageNumber <= this.book.numPages; pageNumber++) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'pdfPlayerThumbnail';
                item.dataset.page = pageNumber;

                const image = document.createElement('img');
                image.className = 'pdfPlayerThumbnailImage';
                image.alt = '';
                image.style.aspectRatio = aspectRatio;

                const label = document.createElement('span');
                label.className = 'pdfPlayerThumbnailLabel';
                label.textContent = pageNumber;

                item.appendChild(image);
                item.appendChild(label);
                fragment.appendChild(item);
                this.items.push(item);
            }

            this.grid.appendChild(fragment);
            this.grid.addEventListener('click', this.onGridClick);

            this.observer = new IntersectionObserver(this.onIntersection, {
                root: this.grid,
                rootMargin: '50% 0px'
            });
            for (const item of this.items) {
                this.observer.observe(item);
            }
        });
    }

    setCurrentPage(pageNumber) {
        this.items[this.currentPage - 1]?.classList.remove('pdfPlayerThumbnail-current');
        this.items[pageNumber - 1]?.classList.add('pdfPlayerThumbnail-current');
        this.currentPage = pageNumber;
    }

    onGridClick(e) {
        const item = e.target.closest('.pdfPlayerThumbnail');
        if (item) {
            this.onSelect(parseInt(item.dataset.page, 10));
        }
    }

    onIntersection(entries) {
        for (const entry of entries) {
            const pageNumber = parseInt(entry.target.dataset.page, 10);
            if (!entry.isIntersecting) {
                this.queue.delete(pageNumber);
            } else if (!this.rendered.has(pageNumber)) {
                this.queue.add(pageNumber);
            }
        }

        this.processQueue();
    }

    processQueue() {
        if (this.rendering || !this.opened || this.destroyed) return;

        const pageNumber = this.queue.values().next().value;
        if (!pageNumber) return;

        this.queue.delete(pageNumber);
        this.rendering = true;
        this.renderThumbnail(pageNumber)
            .catch(err => console.warn('[PdfPlayer] failed to render thumbnail', err))
            .then(() => {
                this.rendering = false;
                this.processQueue();
            });
    }

    renderThumbnail(pageNumber) {
        return this.book.getPage(pageNumber).then(page => {
            if (this.destroyed) return;

            const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
            const original = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH * outputScale / original.width });

            const canvas = this.canvas || (this.canvas = document.createElement('canvas'));
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);

            return page.render({
                canvasContext: canvas.getContext('2d', { alpha: false }),
                viewport
            }).promise.then(() => canvasToUrl(canvas)).then(url => {
                if (this.destroyed) {
                    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                    return;
                }

                this.urls.push(url);
                this.rendered.add(pageNumber);

                const image = this.items[pageNumber - 1].querySelector('.pdfPlayerThumbnailImage');
                image.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
                image.src = url;
            });
        });
    }
}

export default PdfThumbnails;
