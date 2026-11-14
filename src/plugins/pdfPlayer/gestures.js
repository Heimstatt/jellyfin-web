// Touch and mouse gestures for the PDF player.
// Native scrolling of the container is kept for panning, everything else is reported to the handlers.

const TAP_MAX_MOVE = 10;
const TAP_MAX_DURATION = 350;
const DOUBLE_TAP_DELAY = 250;
const DOUBLE_TAP_MAX_DISTANCE = 40;
const SWIPE_MIN_DISTANCE = 50;
const SWIPE_MAX_DURATION = 800;
// browsers emulate mouse events after touch events
const MOUSE_AFTER_TOUCH_DELAY = 800;
const DRAG_MIN_MOVE = 5;
const WHEEL_ZOOM_END_DELAY = 200;

function getDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function getCenter(a, b) {
    return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2
    };
}

function isInteractive(target) {
    return !!target?.closest?.('a, button, input, select, textarea');
}

export class PdfGestures {
    /**
     * @param {HTMLElement} element The scrolling container.
     * @param {Object} handlers Callbacks: onTap(x, y), onDoubleTap(x, y), onSwipe(direction, start),
     * onPinchStart(x, y), onPinchMove(scale, x, y), onPinchEnd(scale, x, y) and onWheel(event).
     */
    constructor(element, handlers) {
        this.element = element;
        this.handlers = handlers;
        this.touch = null;
        this.pinch = null;
        this.drag = null;
        this.lastTap = null;
        this.lastTouchTime = 0;

        this.onTouchStart = this.onTouchStart.bind(this);
        this.onTouchMove = this.onTouchMove.bind(this);
        this.onTouchEnd = this.onTouchEnd.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onClick = this.onClick.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onGestureStart = this.onGestureStart.bind(this);

        element.addEventListener('touchstart', this.onTouchStart, { passive: false });
        element.addEventListener('touchmove', this.onTouchMove, { passive: false });
        element.addEventListener('touchend', this.onTouchEnd, { passive: false });
        element.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
        element.addEventListener('mousedown', this.onMouseDown);
        element.addEventListener('click', this.onClick);
        element.addEventListener('wheel', this.onWheel, { passive: false });
        // Safari fires its own pinch gesture events, the page itself must not zoom
        element.addEventListener('gesturestart', this.onGestureStart, { passive: false });
    }

    destroy() {
        const element = this.element;

        element.removeEventListener('touchstart', this.onTouchStart);
        element.removeEventListener('touchmove', this.onTouchMove);
        element.removeEventListener('touchend', this.onTouchEnd);
        element.removeEventListener('touchcancel', this.onTouchEnd);
        element.removeEventListener('mousedown', this.onMouseDown);
        element.removeEventListener('click', this.onClick);
        element.removeEventListener('wheel', this.onWheel);
        element.removeEventListener('gesturestart', this.onGestureStart);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);

        clearTimeout(this.tapTimeout);
        clearTimeout(this.wheelZoomTimeout);
        this.handlers = null;
    }

    onGestureStart(e) {
        e.preventDefault();
    }

    onTouchStart(e) {
        this.lastTouchTime = Date.now();

        if (e.touches.length === 2) {
            e.preventDefault();
            this.touch = null;

            const [a, b] = e.touches;
            const center = getCenter(a, b);
            this.pinch = {
                distance: getDistance(a, b) || 1,
                scale: 1,
                x: center.x,
                y: center.y
            };
            this.handlers.onPinchStart(center.x, center.y);
        } else if (e.touches.length === 1 && !this.pinch) {
            const touch = e.touches[0];
            const element = this.element;
            this.touch = {
                x: touch.clientX,
                y: touch.clientY,
                time: Date.now(),
                moved: false,
                interactive: isInteractive(e.target),
                scrollLeft: element.scrollLeft,
                maxScrollLeft: element.scrollWidth - element.clientWidth
            };
        } else {
            this.touch = null;
        }
    }

    onTouchMove(e) {
        if (this.pinch) {
            if (e.touches.length < 2) return;
            e.preventDefault();

            const [a, b] = e.touches;
            const center = getCenter(a, b);
            this.pinch.scale = getDistance(a, b) / this.pinch.distance;
            this.pinch.x = center.x;
            this.pinch.y = center.y;
            this.handlers.onPinchMove(this.pinch.scale, center.x, center.y);
        } else if (this.touch && !this.touch.moved) {
            const touch = e.touches[0];
            if (Math.hypot(touch.clientX - this.touch.x, touch.clientY - this.touch.y) > TAP_MAX_MOVE) {
                this.touch.moved = true;
            }
        }
    }

    onTouchEnd(e) {
        this.lastTouchTime = Date.now();

        if (this.pinch) {
            // the remaining finger of a pinch neither taps nor swipes
            if (e.touches.length < 2) {
                const { scale, x, y } = this.pinch;
                this.pinch = null;
                this.handlers.onPinchEnd(scale, x, y);
            }
            return;
        }

        const start = this.touch;
        this.touch = null;
        if (!start || start.interactive || e.type === 'touchcancel' || e.touches.length > 0) return;

        const touch = e.changedTouches[0];
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        const duration = Date.now() - start.time;

        if (!start.moved && duration < TAP_MAX_DURATION) {
            // no emulated mouse events and no native double tap zoom
            e.preventDefault();
            this.onTapGesture(touch.clientX, touch.clientY);
        } else if (Math.abs(dx) > SWIPE_MIN_DISTANCE && Math.abs(dx) > 2 * Math.abs(dy) && duration < SWIPE_MAX_DURATION) {
            this.handlers.onSwipe(dx < 0 ? 'left' : 'right', start);
        }
    }

    onTapGesture(x, y) {
        const now = Date.now();
        const last = this.lastTap;

        clearTimeout(this.tapTimeout);

        if (last && now - last.time < DOUBLE_TAP_DELAY && Math.hypot(x - last.x, y - last.y) < DOUBLE_TAP_MAX_DISTANCE) {
            this.lastTap = null;
            this.handlers.onDoubleTap(x, y);
            return;
        }

        // wait for a possible second tap
        this.lastTap = { x, y, time: now };
        this.tapTimeout = setTimeout(() => {
            this.lastTap = null;
            this.handlers?.onTap(x, y);
        }, DOUBLE_TAP_DELAY);
    }

    isEmulatedMouseEvent() {
        return Date.now() - this.lastTouchTime < MOUSE_AFTER_TOUCH_DELAY;
    }

    onMouseDown(e) {
        if (e.button !== 0 || isInteractive(e.target) || this.isEmulatedMouseEvent()) return;

        this.drag = {
            x: e.clientX,
            y: e.clientY,
            scrollLeft: this.element.scrollLeft,
            scrollTop: this.element.scrollTop,
            moved: false
        };
        this.suppressClick = false;

        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
    }

    onMouseMove(e) {
        const drag = this.drag;
        if (!drag) return;

        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_MIN_MOVE) return;

        // drag to pan a zoomed page
        drag.moved = true;
        this.element.classList.add('pdfPlayerDragging');
        this.element.scrollLeft = drag.scrollLeft - dx;
        this.element.scrollTop = drag.scrollTop - dy;
    }

    onMouseUp() {
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        this.element.classList.remove('pdfPlayerDragging');

        this.suppressClick = !!this.drag?.moved;
        this.drag = null;
    }

    onClick(e) {
        if (this.suppressClick) {
            this.suppressClick = false;
            return;
        }
        if (isInteractive(e.target) || this.isEmulatedMouseEvent()) return;

        this.onTapGesture(e.clientX, e.clientY);
    }

    onWheel(e) {
        if (!e.ctrlKey) {
            this.handlers.onWheel(e);
            return;
        }

        // ctrl + wheel and touchpad pinch zoom like a pinch gesture
        e.preventDefault();

        if (!this.wheelZoom) {
            this.wheelZoom = { scale: 1, x: e.clientX, y: e.clientY };
            this.handlers.onPinchStart(e.clientX, e.clientY);
        }

        const wheelZoom = this.wheelZoom;
        const delta = e.deltaMode === 0 ? e.deltaY : e.deltaY * 20;
        wheelZoom.scale *= Math.exp(-delta / 300);
        this.handlers.onPinchMove(wheelZoom.scale, wheelZoom.x, wheelZoom.y);

        clearTimeout(this.wheelZoomTimeout);
        this.wheelZoomTimeout = setTimeout(() => {
            this.wheelZoom = null;
            this.handlers?.onPinchEnd(wheelZoom.scale, wheelZoom.x, wheelZoom.y);
        }, WHEEL_ZOOM_END_DELAY);
    }
}

export default PdfGestures;
