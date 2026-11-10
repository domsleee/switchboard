import { resumableSockets } from "./resumable.js";
import { handleReconnection, handleDisconnected, markConnectionEstablished, setReconnectHandler, showConnectionStatus } from "./connection.js";
import { authorizedFetch } from "./auth.js";
import { fineScrolling } from "./wheel.js";
import {
    getBaseUrl,
    getWebSocketBaseUrl,
    isCurrentLocation,
} from "./utils.js";
import { setSoftKeyboard } from "./input.js";
import {
    applyTerminalBackground,
    hasRoom,
    terminalConfigOptions,
} from "./terminal.js";

let lastSentCellDimensions = null;

function getCellPixelDimensions(term) {
    try {
        const cell =
            term && term._core && term._core._renderService &&
            term._core._renderService.dimensions &&
            term._core._renderService.dimensions.css &&
            term._core._renderService.dimensions.css.cell;
        if (cell && cell.width && cell.height) {
            return { width: cell.width, height: cell.height };
        }
    } catch (_) {}
    const el = term && term.element &&
        term.element.querySelector(".xterm-char-measure-element");
    if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height) {
            return { width: rect.width, height: rect.height };
        }
    }
    return null;
}

window.__zjSupportsTabViewport = true;

function getMobileRenderSizing() {
    const viewportSizing = window.__zjViewport?.getSizing();
    if (viewportSizing) return viewportSizing;
    return window.__zjMobileUi && window.__zjMobileUi.getRenderSizing
        ? window.__zjMobileUi.getRenderSizing()
        : { pinned: false };
}

function sendSizeUpdate(wsControl, ownWebClientId, term, rows, cols, force = false) {
    if (!wsControl || wsControl.readyState !== WebSocket.OPEN || !ownWebClientId) {
        return;
    }
    const viewport = window.__zjViewport?.dimensions();
    if (viewport) {
        rows = viewport.rows;
        cols = viewport.cols;
        if (!window.__zjViewport.report(viewport) && !force) return;
    }
    wsControl.send(
        JSON.stringify({
            web_client_id: ownWebClientId,
            payload: {
                type: "TerminalResize",
                rows,
                cols,
            },
        })
    );
    const cell = getCellPixelDimensions(term);
    if (!cell) {
        return;
    }
    const cellWidth = Math.round(cell.width);
    const cellHeight = Math.round(cell.height);
    if (
        lastSentCellDimensions &&
        lastSentCellDimensions.width === cellWidth &&
        lastSentCellDimensions.height === cellHeight
    ) {
        return;
    }
    lastSentCellDimensions = { width: cellWidth, height: cellHeight };
    wsControl.send(
        JSON.stringify({
            web_client_id: ownWebClientId,
            payload: {
                type: "TerminalMetrics",
                cell_pixel_width: cellWidth,
                cell_pixel_height: cellHeight,
                text_area_pixel_width: Math.round(cols * cell.width),
                text_area_pixel_height: Math.round(rows * cell.height),
            },
        })
    );
}

export function initWebSockets(boot, term, fitAddon) {
    let ownWebClientId = boot.web_client_id;
    let sessionName = boot.session_name;
    let ready = false;
    let lastPane = null;
    let restorePane = null;
    let focusSent = false;
    let missingPanePrompt = null;
    let stopped = false;
    let settleConnection = null;
    let wsTerminal;
    let wsControl;
    const userConfig = { blink: false, style: false };
    if (boot.config) {
        if (typeof boot.config.cursor_blink !== "undefined") {
            userConfig.blink = true;
        }
        if (typeof boot.config.cursor_style !== "undefined") {
            userConfig.style = true;
        }
    }

    // xterm's public onData combines keyboard input and protocol replies. The
    // bundled core supplies an explicit user-input flag before they are combined.
    // Route replies separately so focus restoration cannot deadlock terminal queries.
    const coreService = term._core?.coreService;
    const triggerDataEvent = coreService?.triggerDataEvent;
    if (triggerDataEvent) coreService.triggerDataEvent = function (data, wasUserInput = false) {
        if (wasUserInput) return triggerDataEvent.call(this, data, true);
        if (wsTerminal?.readyState === WebSocket.OPEN) wsTerminal.send(data);
    };

    function closeSockets() {
        restorePane ||= window.__zjReconnectPane?.() || lastPane;
        window.__zjLastMobileState = undefined;
        ready = false;
        for (const socket of [wsTerminal, wsControl]) {
            if (!socket) continue;
            socket.onclose = socket.onmessage = socket.onopen = null;
        }
        for (const socket of [wsTerminal, wsControl]) socket?.close();
        settleConnection?.(false);
    }

    function connect(nextBoot) {
        closeSockets();
        ownWebClientId = nextBoot.web_client_id;
        sessionName = nextBoot.session_name;
        lastSentCellDimensions = null;
        focusSent = false;
        let missingPaneReported = false;
        const connectionResult = new Promise(resolve => {
            // Starting an attachment worker can take longer than a socket pair, notably
            // on Windows with Defender. Giving up early used to fall back to the legacy,
            // non-resumable sockets, which every later service update then disconnects.
            const timeout = setTimeout(() => { closeSockets(); },
                nextBoot.resumable?.protocol === 1 ? 30000 : 5000);
            settleConnection = (ok) => {
                clearTimeout(timeout);
                settleConnection = null;
                resolve(ok);
            };
        });
        const wsBaseUrl = getWebSocketBaseUrl();
        const url =
            !sessionName || sessionName === ""
                ? `${wsBaseUrl}/ws/terminal`
                : `${wsBaseUrl}/ws/terminal/${encodeURIComponent(sessionName)}`;

        const proposed = fitAddon.proposeDimensions();
        const fitDimensions = hasRoom(proposed) ? proposed : {
            rows: term.rows,
            cols: term.cols,
        };
        if (
            fitDimensions.rows !== term.rows ||
            fitDimensions.cols !== term.cols
        ) {
            term.resize(fitDimensions.cols, fitDimensions.rows);
        }
        const cell = getCellPixelDimensions(term);
        let queryString = `?web_client_id=${encodeURIComponent(ownWebClientId)}&rows=${term.rows}&cols=${term.cols}`;
        if (cell) {
            const cellWidth = Math.round(cell.width);
            const cellHeight = Math.round(cell.height);
            queryString += `&cell_width=${cellWidth}&cell_height=${cellHeight}`;
            lastSentCellDimensions = { width: cellWidth, height: cellHeight };
        }
        // Fine scrolling: the wheel handler sends one report per line, so Zellij
        // scrolls one line per report instead of three.
        if (fineScrolling()) queryString += "&wheel_lines=1";
        // A viewer the embedding page hides (Switchboard's Conversation) attaches
        // without sizing its tab for the screens people can see.
        if (window.__zjViewerHidden?.()) queryString += "&hidden=true";
        const wsTerminalUrl = `${url}${queryString}`;

        if (nextBoot.resumable?.protocol === 1) {
            const pair = resumableSockets(wsBaseUrl, nextBoot, { rows: term.rows, cols: term.cols,
                wheel_lines: fineScrolling() ? 1 : 0 });
            wsTerminal = pair.terminal;
            wsControl = pair.control;
            // Transport retries stay within this owner and retain its focus.
            // A fresh bootstrap after expiry must restore the previous pane
            // before releasing typing, just like a legacy socket replacement.
        } else {
            wsTerminal = new WebSocket(wsTerminalUrl);
            wsControl = new WebSocket(`${wsBaseUrl}/ws/control?web_client_id=${encodeURIComponent(ownWebClientId)}`);
        }
        startWsControl(wsControl, term, fitAddon, ownWebClientId, userConfig, payload => {
            lastPane = payload.active_pane || null;
            if (restorePane && lastPane) {
                if (lastPane.pane_id === restorePane.pane_id && lastPane.is_plugin === restorePane.is_plugin) {
                    restorePane = null;
                } else if (Array.isArray(payload.panes) && !payload.panes.some(pane => pane.pane_id === restorePane.pane_id && pane.is_plugin === restorePane.is_plugin)) {
                    // The connection is healthy, but the old target no longer
                    // exists. Keep input paused until the user acknowledges the
                    // currently displayed terminal.
                    if (!missingPaneReported) {
                        missingPaneReported = true;
                        const missing = restorePane, control = wsControl;
                        settleConnection?.(true);
                        missingPanePrompt ||= showErrorModal("Terminal closed", "The terminal you were viewing has closed. Acknowledge to continue in the currently displayed terminal.").finally(() => { missingPanePrompt = null; });
                        missingPanePrompt.then(() => {
                            if (control !== wsControl || stopped) return;
                            if (restorePane?.pane_id === missing.pane_id && restorePane.is_plugin === missing.is_plugin) restorePane = null;
                            connected();
                        });
                    }
                } else if (!focusSent) {
                    window.__zjSendControl({ type: "FocusPane", pane_id: restorePane.pane_id, is_plugin: restorePane.is_plugin });
                }
            }
            connected();
        });
        window.__zjSendControl = function (payload) {
            // A tab selection made during recovery supersedes the old target,
            // including when its control request must wait for a socket.
            if (restorePane && payload.type === "FocusPane") {
                restorePane = { pane_id: payload.pane_id, is_plugin: payload.is_plugin };
                focusSent = false;
            }
            if (wsControl && wsControl.readyState === WebSocket.OPEN) {
                wsControl.send(
                    JSON.stringify({
                        web_client_id: ownWebClientId,
                        payload,
                    })
                );
                if (restorePane && payload.type === "FocusPane") focusSent = true;
            }
        };

        const connected = () => {
            if (!ready && !restorePane && !missingPanePrompt && wsTerminal.readyState === WebSocket.OPEN && wsControl.readyState === WebSocket.OPEN) {
                ready = true;
                markConnectionEstablished();
                settleConnection?.(true);
            }
        };
        wsTerminal.onopen = connected;
        wsControl.onopen = connected;

        wsTerminal.onmessage = function (event) {
            let data = event.data;

            if (typeof data === "string") {
                // Handle ANSI title change sequences
                const titleRegex = /\x1b\]0;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
                let match;
                while ((match = titleRegex.exec(data)) !== null) {
                    document.title = match[1];
                }

                if ((userConfig.blink || userConfig.style) && (
                    data.includes("\x1b[0 q") ||
                    data.includes("\x1b[1 q") ||
                    data.includes("\x1b[2 q") ||
                    data.includes("\x1b[3 q") ||
                    data.includes("\x1b[4 q") ||
                    data.includes("\x1b[5 q") ||
                    data.includes("\x1b[6 q")
                )) {
                    data = data.replace(/\x1b\[([0-6]) q/g, (match, p1) => {
                        const id = parseInt(p1);

                        // Decode app-requested blink and shape from DECSCUSR id
                        // id 0 = reset-to-default (null = no preference)
                        const appBlink = id === 0 ? null : (id % 2 === 1);
                        const appShapes = [null, "block", "block", "underline", "underline", "bar", "bar"];
                        const appShape  = appShapes[id];

                        // Apply user overrides only for what was explicitly configured;
                        // otherwise pass through the app's value (or fall back to term.options)
                        const effectiveBlink = userConfig.blink ? term.options.cursorBlink
                                                                : (appBlink !== null ? appBlink : term.options.cursorBlink);
                        const effectiveShape = userConfig.style ? term.options.cursorStyle
                                                                : (appShape !== null ? appShape : term.options.cursorStyle);

                        if (effectiveShape === "block")     return effectiveBlink ? "\x1b[1 q" : "\x1b[2 q";
                        if (effectiveShape === "underline") return effectiveBlink ? "\x1b[3 q" : "\x1b[4 q";
                        if (effectiveShape === "bar")       return effectiveBlink ? "\x1b[5 q" : "\x1b[6 q";
                        return match;
                    });
                }
            }

            term.write(data, event.applied);
        };

        const closed = (event) => {
            closeSockets();
            if (event.code === 4001) {
                stopped = true;
                handleDisconnected(wsTerminal?.resumable ? window.__zjResumeFailure : undefined);
            } else if (!stopped) {
                handleReconnection();
            }
        };
        wsTerminal.onclose = closed;
        wsControl.onclose = closed;
        return connectionResult;
    }

    setReconnectHandler(async () => {
        if (stopped) return false;
        // Session switching updates the URL without recreating this terminal.
        const currentSession = decodeURIComponent(location.pathname.split("/").pop()) || sessionName;
        const base = getBaseUrl();
        const recovery = { quiet: true, timeoutMs: 5000 };
        const catalog = await authorizedFetch(`${base}/session-list`, {}, recovery);
        if (!catalog.ok) return false;
        const { sessions } = await catalog.json();
        if (!sessions.some(session => session.name === currentSession && session.web_clients_allowed)) return false;
        // Ask for a resumable attachment again, so one reconnect does not leave
        // this viewer on legacy sockets until the page reloads.
        const response = await authorizedFetch(`${base}/session?session=${encodeURIComponent(currentSession)}&welcome=false&resumable=true`, {
            method: "POST",
        }, recovery);
        if (!response.ok || stopped) return false;
        return connect(await response.json());
    });
    connect(boot).then(ok => { if (!ok && !stopped) handleReconnection(); });

    const sendAnsiKey = (ansiKey) => {
        let payload = ansiKey;
        if (typeof window.__zjMobileMergeKey === "function") {
            payload = window.__zjMobileMergeKey(payload);
        }
        if (!ready) {
            showConnectionStatus();
            return;
        }
        if (term.options.disableStdin) return;
        wsTerminal.send(payload);
    };

    setupResizeHandler(
        term,
        fitAddon,
        () => wsControl,
        () => ownWebClientId
    );

    return {
        get wsTerminal() { return wsTerminal; },
        getWsControl: () => wsControl,
        getOwnWebClientId: () => ownWebClientId,
        sendAnsiKey,
        cleanup: () => {
            stopped = true;
            closeSockets();
            if (triggerDataEvent) coreService.triggerDataEvent = triggerDataEvent;
        },
    };
}

function startWsControl(wsControl, term, fitAddon, ownWebClientId, userConfig, onState) {
    wsControl.onmessage = function (event) {
        const msg = JSON.parse(event.data);
        if (msg.type === "SetConfig") {
            const options = terminalConfigOptions(msg);
            for (const key of Object.keys(options)) {
                term.options[key] = options[key];
            }
            if (typeof msg.cursor_blink !== "undefined") {
                userConfig.blink = true;
            }
            if (typeof msg.cursor_style !== "undefined") {
                userConfig.style = true;
            }
            if (typeof window.__zjSyncInactiveCursorStyle === "function") {
                window.__zjSyncInactiveCursorStyle();
            }
            applyTerminalBackground(msg);
        } else if (msg.type === "QueryTerminalSize") {
            const sizing = getMobileRenderSizing();
            if (sizing.pinned) {
                if (sizing.rows !== term.rows || sizing.cols !== term.cols) {
                    term.resize(sizing.cols, sizing.rows);
                }
                sendSizeUpdate(
                    wsControl,
                    ownWebClientId,
                    term,
                    sizing.rows,
                    sizing.cols,
                    true
                );
            } else {
                const fitDimensions = window.__zjViewport?.dimensions() || fitAddon.proposeDimensions();
                if (hasRoom(fitDimensions)) {
                    const { rows, cols } = fitDimensions;
                    if (rows !== term.rows || cols !== term.cols) {
                        term.resize(cols, rows);
                    }
                    sendSizeUpdate(wsControl, ownWebClientId, term, rows, cols, true);
                }
            }
        } else if (msg.type === "Log") {
            const { lines } = msg;
            for (const line in lines) {
                console.log(line);
            }
        } else if (msg.type === "LogError") {
            const { lines } = msg;
            for (const line in lines) {
                console.error(line);
            }
        } else if (msg.type === "SwitchedSession") {
            const { new_session_name } = msg;
            const baseUrl = getBaseUrl();
            const target = `${baseUrl}/${encodeURIComponent(new_session_name)}`;
            if (!isCurrentLocation(target)) {
                history.pushState(null, "", target);
                document.title = new_session_name;
            }
        } else if (msg.type === "SetSoftKeyboard") {
            const { on } = msg;
            setSoftKeyboard(term, !!on);
        } else if (msg.type === "MobileState") {
            const { payload } = msg;
            if (payload) {
                window.__zjLastMobileState = payload;
                onState(payload);
                if (window.__zjMobileUi) {
                    window.__zjMobileUi.setData(payload);
                }
            }
        }
    };


}

export function setupResizeHandler(
    term,
    fitAddon,
    getWsControl,
    getOwnWebClientId
) {
    let resizeScheduled = false;
    let pendingResizeSignal = false;

    const updateViewportVars = () => {
        const root = document.documentElement;
        const viewport = window.visualViewport;
        const height = viewport ? viewport.height : window.innerHeight;
        const width = viewport ? viewport.width : window.innerWidth;
        root.style.setProperty("--dynamic-vh", `${height}px`);
        root.style.setProperty("--dynamic-vw", `${width}px`);
    };

    const resizeTerminal = () => {
        const ownWebClientId = getOwnWebClientId();
        if (ownWebClientId === "") {
            return;
        }

        const sizing = getMobileRenderSizing();

        if (window.__zjViewport?.dimensions()) {
            sendSizeUpdate(getWsControl(), ownWebClientId, term, term.rows, term.cols);
        }

        if (sizing.pinned) {
            if (sizing.rows !== term.rows || sizing.cols !== term.cols) {
                term.resize(sizing.cols, sizing.rows);
                if (window.__zjViewport?.dimensions()) {
                    sendSizeUpdate(getWsControl(), ownWebClientId, term, term.rows, term.cols, true);
                }
            }
            if (window.__zjMobilePan) {
                window.__zjMobilePan.recompute();
            }
            return;
        }

        const fitDimensions = window.__zjViewport?.dimensions() || fitAddon.proposeDimensions();
        if (fitDimensions === undefined) {
            console.warn("failed to get new fit dimensions");
            return;
        }
        if (!hasRoom(fitDimensions)) return;

        const { rows, cols } = fitDimensions;
        if (rows === term.rows && cols === term.cols) {
            return;
        }

        const wsControl = getWsControl();
        term.resize(cols, rows);

        sendSizeUpdate(wsControl, ownWebClientId, term, rows, cols, !!window.__zjViewport?.dimensions());
    };

    const handleViewportChange = () => {
        updateViewportVars();
        resizeTerminal();
    };

    const scheduleResize = () => {
        pendingResizeSignal = true;
        if (resizeScheduled) {
            return;
        }
        resizeScheduled = true;
        requestAnimationFrame(() => {
            resizeScheduled = false;
            if (!pendingResizeSignal) {
                return;
            }
            pendingResizeSignal = false;
            handleViewportChange();
        });
    };

    updateViewportVars();
    addEventListener("resize", scheduleResize);
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", scheduleResize);
    }
    addEventListener("zellij:rendering-resize", scheduleResize);

    setupSoftKeyboardVisibilityTracker(getWsControl, getOwnWebClientId);
}

function setupSoftKeyboardVisibilityTracker(getWsControl, getOwnWebClientId) {
    if (!window.visualViewport) {
        return;
    }
    const VIEWPORT_DELTA_THRESHOLD_PX = 150;
    let lastViewportHeight = window.visualViewport.height;
    let kbdVisible = false;

    const onResize = () => {
        const newHeight = window.visualViewport.height;
        const delta = newHeight - lastViewportHeight;
        let newKbdVisible = kbdVisible;
        if (delta < -VIEWPORT_DELTA_THRESHOLD_PX) {
            newKbdVisible = true;
        } else if (delta > VIEWPORT_DELTA_THRESHOLD_PX) {
            newKbdVisible = false;
        }
        lastViewportHeight = newHeight;
        if (newKbdVisible === kbdVisible) {
            return;
        }
        kbdVisible = newKbdVisible;

        window.dispatchEvent(
            new CustomEvent("zellij:soft-keyboard-visibility", {
                detail: { visible: kbdVisible },
            })
        );

        if (!kbdVisible) {
            const capture =
                window.__zjSoftKbdCapture &&
                window.__zjSoftKbdCapture.element;
            if (capture && window.__zjSoftKbdCapture.isFocused) {
                capture.blur();
            }
        }

        const wsControl = getWsControl();
        const ownWebClientId = getOwnWebClientId();
        if (!wsControl || wsControl.readyState !== WebSocket.OPEN || ownWebClientId === "") {
            return;
        }
        wsControl.send(
            JSON.stringify({
                web_client_id: ownWebClientId,
                payload: {
                    type: "SoftKeyboardVisibilityChanged",
                    visible: kbdVisible,
                },
            })
        );
    };

    window.visualViewport.addEventListener("resize", onResize);
}
