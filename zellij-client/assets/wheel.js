// xterm.js sends one mouse wheel report per browser wheel event, however far the
// wheel moved, and Zellij scrolls 3 lines per report. So a Linux wheel notch
// (one ~120px event) scrolled 3 lines while a touchpad scrolled 3 lines for
// every row of finger travel. Report by distance instead: one report per
// WHEEL_ROWS_PER_REPORT rows moved, so text moves as far as the gesture did.
export const WHEEL_ROWS_PER_REPORT = 3;
// A pause this long starts a new gesture, which always scrolls at least once.
export const WHEEL_GESTURE_GAP_MS = 200;

export function wheelRows(event, rowHeight, rows) {
    if (event.deltaMode === 1) return event.deltaY;
    if (event.deltaMode === 2) return event.deltaY * rows;
    return rowHeight > 0 ? event.deltaY / rowHeight : 0;
}

// Returns the signed number of reports owed for each wheel event.
export function createWheelAccumulator(
    rowsPerReport = WHEEL_ROWS_PER_REPORT,
    gestureGapMs = WHEEL_GESTURE_GAP_MS
) {
    let pending = 0;
    let direction = 0;
    let lastTime = -Infinity;
    return function add(rows, time) {
        if (!rows) return 0;
        const sign = Math.sign(rows);
        const newGesture = sign !== direction || time - lastTime > gestureGapMs;
        lastTime = time;
        if (newGesture) {
            direction = sign;
            pending = 0;
        }
        pending += rows;
        let reports = Math.trunc(pending / rowsPerReport);
        // The first event of a gesture always scrolls, so a single small notch
        // is never lost. It leaves no debt: paying it back would stall the next
        // rows of a swipe right after it starts.
        if (newGesture && reports === 0) {
            pending = 0;
            return sign;
        }
        pending -= reports * rowsPerReport;
        return reports;
    };
}

export function installWheelHandler(term) {
    const core = term._core;
    const add = createWheelAccumulator();
    let queued = 0;
    let target = null;
    let frame = 0;

    function flush() {
        frame = 0;
        const count = Math.abs(queued);
        const action = queued < 0 ? 0 : 1;
        queued = 0;
        if (!target) return;
        let sent = 0;
        for (let i = 0; i < count; i++) {
            if (core.coreMouseService.triggerMouseEvent({ ...target, button: 4, action })) sent++;
        }
        if (sent) window.__zjOnWheelReports?.(sent);
    }

    term.attachCustomWheelEventHandler((event) => {
        // Without mouse reporting (or in X10 mode, which has no wheel), xterm
        // scrolls or sends arrow keys itself. Ctrl+wheel resizes panes one step
        // per notch, and Shift or horizontal wheels are not vertical scrolling.
        const mode = term.modes.mouseTrackingMode;
        if (mode === "none" || mode === "x10" || !core.coreMouseService.areMouseEventsActive) return true;
        if (event.ctrlKey || event.shiftKey || !event.deltaY) return true;
        const position = core._mouseService.getMouseReportCoords(event, core.screenElement);
        if (!position) return true;
        const rowHeight = core._renderService?.dimensions?.css?.cell?.height;
        const reports = add(wheelRows(event, rowHeight, term.rows), event.timeStamp);
        if (reports) {
            if (Math.sign(reports) !== Math.sign(queued)) queued = 0;
            queued += reports;
            target = {
                col: position.col,
                row: position.row,
                x: position.x,
                y: position.y,
                ctrl: false,
                alt: event.altKey,
                shift: false,
            };
            if (!frame) frame = requestAnimationFrame(flush);
        }
        // false: xterm sends no report of its own and cancels the event.
        return false;
    });
}
