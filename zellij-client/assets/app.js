/**
 * Utility functions for the terminal web client
 */

/**
 * Check if the current page is served over HTTPS
 * @returns {boolean} true if protocol is https:, false otherwise
 */
function is_https() {
    return document.location.protocol === "https:";
}

function isMac() {
    if (navigator.userAgentData && navigator.userAgentData.platform) {
        return navigator.userAgentData.platform === "macOS";
    }
    return navigator.platform.toUpperCase().includes("MAC");
}

/**
 * Get the application base URL, derived from the location of this module.
 * Modules are always served from `<base>/assets/<file>.js`, so stripping the
 * trailing `/assets/<file>.js` yields the mount point of the web client.
 * @returns {string} Base URL without a trailing slash
 */
function getBaseUrl() {
    try {
        const moduleUrl = new URL(import.meta.url);
        const path = moduleUrl.pathname.replace(/\/assets\/[^/]*$/, "");
        return `${moduleUrl.origin}${path}`.replace(/\/$/, "");
    } catch (_) {
        return window.location.origin;
    }
}

/**
 * Check whether a target URL points at the page already being displayed,
 * ignoring the query string and fragment.
 * @param {string} target absolute or relative URL
 * @returns {boolean} true if navigating there would only reload the page
 */
function isCurrentLocation(target) {
    try {
        const targetUrl = new URL(target, window.location.href);
        const stripTrailingSlash = (path) => path.replace(/\/$/, "");
        return (
            targetUrl.origin === window.location.origin &&
            stripTrailingSlash(targetUrl.pathname) ===
                stripTrailingSlash(window.location.pathname)
        );
    } catch (_) {
        return false;
    }
}

/**
 * Detect a mobile viewport (coarse pointer + small width, or a mobile UA).
 * @returns {boolean} true if the current viewport is considered mobile
 */
function isMobileViewport() {
    return (
        (window.matchMedia &&
            window.matchMedia("(pointer: coarse)").matches &&
            window.innerWidth < 600) ||
        /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    );
}

/**
 * Get the application base URL converted to a WebSocket URL
 * @returns {string} WebSocket base URL
 */
function getWebSocketBaseUrl() {
    return getBaseUrl().replace(/^https?/, is_https() ? "wss" : "ws");
}
/** Reconnect the sockets in place; the terminal and its input handlers survive. */
let reconnectionAttempt = 0;
let isReconnecting = false;
let isDisconnected = false;
let isPageUnloading = false;
let reconnectHandler = null;
let connectionStatus = null;
let statusTimer = null;
let connectedAt = 0;
const QUICK_ATTEMPTS = 40;

function getReconnectionDelay(attempt) {
    if (attempt <= QUICK_ATTEMPTS) return 0.25;
    const delays = [1, 2, 4, 8, 16];
    return delays[Math.min(attempt - QUICK_ATTEMPTS - 1, delays.length - 1)];
}

function setReconnectHandler(handler) {
    reconnectHandler = handler;
}

function showConnectionStatus(message = "Reconnecting… Input paused") {
    if (connectionStatus || isPageUnloading || isDisconnected) return;
    connectionStatus = document.createElement("div");
    connectionStatus.setAttribute("role", "status");
    connectionStatus.textContent = message;
    connectionStatus.style.cssText = "position:fixed;right:12px;top:12px;z-index:10000;padding:6px 10px;border-radius:6px;background:#252525;color:#eee;font:13px sans-serif;pointer-events:none";
    document.body.appendChild(connectionStatus);
}

function clearConnectionStatus() {
    clearTimeout(statusTimer);
    statusTimer = null;
    connectionStatus?.remove();
    connectionStatus = null;
}

async function handleDisconnected(reason = "You have been disconnected by the host.") {
    if (isDisconnected || isPageUnloading) return;
    isDisconnected = true;
    isReconnecting = false;
    clearConnectionStatus();
    const failure = window.__zjTerminalFailure || {
        reference:crypto.randomUUID().replaceAll('-','').slice(0,12),
        code:reason.startsWith('Engine did not confirm terminal pane selection')?'focus_unconfirmed':
          reason.startsWith('Terminal pane selection was not confirmed')?'focus_timeout':
          reason.startsWith('Requested terminal pane could not be selected')?'pane_unavailable':
          reason.startsWith('Terminal attachment could not resume')?'resume_timeout':
          reason.startsWith('Pending terminal input reached')?'input_limit':
          reason.startsWith('Terminal renderer unavailable')?'renderer_unavailable':
          /^(Invalid terminal|Unknown terminal|Terminal output sequence)/.test(reason)?'invalid_delivery':'browser_failure',session:'',
        pane_id:null,is_plugin:false,operation:'browser',elapsed_ms:Math.min(86400000,Math.round(performance.now())),
        focus_confirmed:false,query_received:false,worker_build:null,engine_build:null,pending_records:window.__zjPendingTerminalRecords??null,
    };
    if (!window.__zjTerminalFailure) reason += `\nReference: ${failure.reference}`;
    // The source computer exposes its durable report through paired Logs.
    // Browser reporting is a fallback, so remote viewers do not create a second copy.
    if (!window.__zjTerminalFailureSaved) window.dispatchEvent(new CustomEvent('zellij-terminal-failed',{detail:failure}));
    await showErrorModal("Disconnected", reason);
}

async function handleReconnection() {
    if (isReconnecting || isDisconnected || isPageUnloading || !reconnectHandler) return;
    isReconnecting = true;
    // Repeated immediately rejected attachments must eventually back off too.
    if (connectedAt && Date.now() - connectedAt > 30000) reconnectionAttempt = 0;
    statusTimer = setTimeout(showConnectionStatus, 1500);
    while (isReconnecting && !isPageUnloading && !isDisconnected) {
        await new Promise(resolve => setTimeout(resolve, getReconnectionDelay(++reconnectionAttempt) * 1000));
        if (isPageUnloading || isDisconnected) break;
        try {
            if (await reconnectHandler()) {
                isReconnecting = false;
                clearConnectionStatus();
                return;
            }
        } catch (_) {
            // A failed bootstrap or socket pair retries without rebuilding the page.
        }
    }
    isReconnecting = false;
    clearConnectionStatus();
}

function initConnectionHandlers() {
    const unload = () => { isPageUnloading = true; clearConnectionStatus(); };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", unload);
}

function markConnectionEstablished() {
    connectedAt = Date.now();
    clearConnectionStatus();
}

function resetConnectionState() {
    reconnectionAttempt = 0;
    isReconnecting = false;
    isDisconnected = false;
    isPageUnloading = false;
    connectedAt = 0;
    clearConnectionStatus();
}
/**
 * Authentication logic and token management
 */


/**
 * Wait for user to provide a security token
 * @returns {Promise<{token: string, remember: boolean}>}
 */
async function waitForSecurityToken() {
    let token = null;
    let remember = null;

    while (!token) {
        let result = await getSecurityToken();
        if (result) {
            token = result.token;
            remember = result.remember;
        } else {
            await showErrorModal(
                "Error",
                "Must provide security token in order to log in."
            );
        }
    }

    return { token, remember };
}

/**
 * Perform the login exchange with the server
 * @param {string} token - Authentication token
 * @param {boolean} rememberMe - Remember login preference
 * @returns {Promise<boolean>} true when the login succeeded
 */
async function login(token, rememberMe) {
    const baseUrl = getBaseUrl();
    let login_res = await fetch(`${baseUrl}/command/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            auth_token: token,
            remember_me: rememberMe ? true : false,
        }),
        credentials: "include",
    });

    if (login_res.status === 401) {
        await showErrorModal("Error", "Unauthorized or revoked login token.");
        return false;
    } else if (!login_res.ok) {
        await showErrorModal(
            "Error",
            `Error ${login_res.status} connecting to server.`
        );
        return false;
    }
    return true;
}

let pendingAuthentication = null;
let authenticationGeneration = 0;

/**
 * Authenticate, coalescing concurrent callers onto a single prompt.
 *
 * Any number of requests may be rejected at once - the session menu polls while
 * the page is still booting, for example. Each one asking the user separately
 * would stack a dialog per rejection, so the first caller owns the prompt and
 * the rest await its result. They all resume together once it settles, and
 * retry against the credentials it established.
 *
 * @returns {Promise<boolean>} true when the login succeeded
 */
function authenticate() {
    if (!pendingAuthentication) {
        pendingAuthentication = (async () => {
            try {
                const { token, remember } = await waitForSecurityToken();
                return await login(token, remember);
            } finally {
                // Cleared before the awaiting callers run, so a later rejection
                // opens a fresh prompt rather than reusing this settled one.
                authenticationGeneration += 1;
                pendingAuthentication = null;
            }
        })();
    }
    return pendingAuthentication;
}

/**
 * Perform a request, authenticating and retrying for as long as it is rejected.
 * @param {string} url - Absolute URL to request
 * @param {Object} options - fetch options, merged over the credentialed defaults
 * @param {Object} recovery - quiet returns non-auth failures for background retry; timeoutMs applies per request
 * @returns {Promise<Response>} The response (including temporary attachment unavailability)
 */
async function authorizedFetch(url, options = {}, { quiet = false, timeoutMs } = {}) {
    while (true) {
        const generation = authenticationGeneration;

        const response = await fetch(url, {
            credentials: "include",
            ...options,
            ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });

        if (response.ok) {
            return response;
        }

        if (response.status !== 401) {
            // Bootstrap handles 503 while an attachment worker updates. Other
            // failures belong to the caller, never the authentication dialog.
            if (quiet || response.status === 503) return response;
            throw new Error(`Error ${response.status} connecting to server.`);
        }

        // Switchboard owns the upstream credentials and refreshes them in its
        // relay. Asking inside its iframe cannot repair that connection.
        if (window.__switchboardManagedFocus) {
            if (quiet) return response;
            throw new Error("Switchboard could not authenticate this terminal. Reload after the connection recovers.");
        }

        // A request in flight across an authentication was answered against the
        // credentials of the moment it was sent, so its rejection says nothing
        // about the ones we hold now. Retry it before asking the user again.
        if (authenticationGeneration !== generation) {
            continue;
        }

        await authenticate();
    }
}

/**
 * Request a session from the server, authenticating first if required.
 * @param {string} sessionFromPath - Session name taken from the URL path
 * @param {Object} options - `{ welcome: boolean }`, welcome defaulting to true
 * @returns {Promise<Object>} The full session bootstrap payload
 */
async function fetchSession(sessionFromPath, options = {}) {
    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();
    params.set("resumable", "true");
    if (sessionFromPath) {
        params.set("session", sessionFromPath);
    }
    if (options.welcome === false) {
        params.set("welcome", "false");
    }
    const query = params.toString() ? `?${params.toString()}` : "";

    const deadline = Date.now() + 60000;
    for (;;) {
        let response;
        try {
            response = await authorizedFetch(`${baseUrl}/session${query}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            }, { quiet: true, timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())) });
        } catch (error) {
            // A relay update can reset the request or time out before the peer's
            // replacement gateway is ready. Only retry a named session: a lost
            // welcome response may already have created a new session.
            if (!sessionFromPath || !['TypeError', 'AbortError', 'TimeoutError'].includes(error.name)) throw error;
        }
        if (response?.ok) return await response.json();
        if (response?.status === 401 && window.__switchboardManagedFocus) {
            throw new Error("Switchboard could not authenticate this terminal. Reload after the connection recovers.");
        }
        const retryable = response?.status === 503 || (sessionFromPath && [502, 504].includes(response?.status));
        if ((response && !retryable) || Date.now() >= deadline) {
            throw new Error("Terminal attachment is unavailable. Reload after the update finishes.");
        }
        showConnectionStatus("Waiting for terminal attachment…");
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

/**
 * Fetch the list of live sessions without attaching to any of them.
 * @returns {Promise<Array<Object>>} The session descriptors
 */
async function fetchSessionList() {
    const baseUrl = getBaseUrl();
    const response = await authorizedFetch(`${baseUrl}/session-list`, {
        method: "GET",
    });
    const payload = await response.json();
    return payload.sessions || [];
}
/**
 * Keyboard handling functions
 */

/**
 * Encode a keyboard event into kitty protocol ANSI escape sequence
 * @param {KeyboardEvent} ev - The keyboard event to encode
 * @param {function} send_ansi_key - Function to send the ANSI key sequence
 */
function encode_kitty_key(ev, send_ansi_key) {
    let shift_value = 1;
    let alt_value = 2;
    let ctrl_value = 4;
    let super_value = 8;
    let modifier_string = 1;
    if (ev.shiftKey) {
        modifier_string += shift_value;
    }
    if (ev.altKey) {
        modifier_string += alt_value;
    }
    if (ev.ctrlKey) {
        modifier_string += ctrl_value;
    }
    if (ev.metaKey) {
        modifier_string += super_value;
    }
    // Navigation keys use their standard CSI names, not the first letter of
    // KeyboardEvent.key (eg. Ctrl+Shift+ArrowLeft must not become Ctrl+Shift+A).
    const cursor = {ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D",
        Home: "H", End: "F", F1: "P", F2: "Q", F3: "R", F4: "S"};
    if (cursor[ev.key]) {
        send_ansi_key(`\x1b[1;${modifier_string}${cursor[ev.key]}`);
        return;
    }
    const tilde = {Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
        F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24};
    if (tilde[ev.key]) {
        send_ansi_key(`\x1b[${tilde[ev.key]};${modifier_string}~`);
        return;
    }
    // Named keys use their C0 code, not the first letter of their name.
    const named = { Enter: 13, Tab: 9, Escape: 27, Backspace: 127 };
    let key_code = named[ev.key] ?? ev.key.charCodeAt(0);
    send_ansi_key(`\x1b[${key_code};${modifier_string}u`);
}
/**
 * Link handling functions for terminal
 */

/**
 * Build a link handler object for terminal links
 * @returns {object} Object containing linkHandler and activateLink function
 */
function build_link_handler() {
    let _linkPopup;
    
    function removeLinkPopup(event, text, range) {
        if (_linkPopup) {
            _linkPopup.remove();
            _linkPopup = undefined;
        }
    }

    function showLinkPopup(event, text, range) {
        let popup = document.createElement('div');
        popup.classList.add('xterm-link-popup');
        popup.style.position = 'absolute';
        popup.style.top = (event.clientY + 25) + 'px';
        popup.style.left = (event.clientX + 25) + 'px';
        popup.style.fontSize = 'small';
        popup.style.lineBreak = 'normal';
        popup.style.padding = '4px';
        popup.style.minWidth = '15em';
        popup.style.maxWidth = '80%';
        popup.style.border = 'thin solid';
        popup.style.borderRadius = '6px';
        popup.style.background = '#6c4c4c';
        popup.style.borderColor = '#150262';
        popup.innerText = "Shift-Click: " + text;
        const topElement = event.target.parentNode;
        topElement.appendChild(popup);
        const popupHeight = popup.offsetHeight;
        _linkPopup = popup;
    }
    
    function activateLink(event, uri) {
        const newWindow = window.open(uri, '_blank');
        if (newWindow) newWindow.opener = null; // prevent the opened link from gaining access to the terminal instance
    }

    let linkHandler = {};
    linkHandler.hover = showLinkPopup;
    linkHandler.leave = removeLinkPopup;
    linkHandler.activate = activateLink;
    return { linkHandler, activateLink };
}
// xterm.js sends one mouse wheel report per browser wheel event, however far the
// wheel moved, and Zellij scrolls 3 lines per report. So a Linux wheel notch
// (one ~120px event) scrolled 3 lines while a touchpad scrolled 3 lines for
// every row of finger travel. Report by distance instead: one report per
// WHEEL_ROWS_PER_REPORT rows moved, so text moves as far as the gesture did.
const WHEEL_ROWS_PER_REPORT = 3;
// A pause this long starts a new gesture, which always scrolls at least once.
const WHEEL_GESTURE_GAP_MS = 200;

// Switchboard's Fine scrolling setting: one report per row, each scrolling one line.
function fineScrolling() {
    try {
        return localStorage.getItem("switchboard-fine-scroll") === "true";
    } catch (_) {
        return false;
    }
}

function wheelRows(event, rowHeight, rows) {
    if (event.deltaMode === 1) return event.deltaY;
    if (event.deltaMode === 2) return event.deltaY * rows;
    return rowHeight > 0 ? event.deltaY / rowHeight : 0;
}

// Returns the signed number of reports owed for each wheel event.
function createWheelAccumulator(
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

function installWheelHandler(term) {
    const core = term._core;
    const add = createWheelAccumulator(fineScrolling() ? 1 : WHEEL_ROWS_PER_REPORT);
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

const NATURAL_MIN_TOTAL_ROWS = 25;
const MOBILE_LEGIBLE_FLOOR_PX = 12;

// drawImage on a composited WebGL canvas returns blank pixels unless
// preserveDrawingBuffer is set (needed by the pinch overlay snapshot); this must
// run before xterm.js's WebglAddon creates its context.
function ensurePreserveDrawingBuffer() {
    if (window.__zjPreserveDrawingBuffer) return;
    window.__zjPreserveDrawingBuffer = true;
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
        if (type === "webgl" || type === "webgl2") {
            options = Object.assign({}, options || {}, {
                preserveDrawingBuffer: true,
            });
        }
        return orig.call(this, type, options);
    };
}

// Nerd Font icons (private use area only, see style.css): macOS fallback never
// supplies them, and first place beats stale v2 Nerd Fonts' reassigned glyphs.
const NERD_SYMBOLS_FIRST = '"Symbols Nerd Font Mono", ';

function terminalConfigOptions(config) {
    const options = {};
    if (!config) {
        return options;
    }
    if (typeof config.font === "string" && config.font !== "") {
        options.fontFamily = NERD_SYMBOLS_FIRST + config.font;
    }
    if (config.theme) {
        options.theme = config.theme;
    }
    if (typeof config.cursor_blink !== "undefined") {
        options.cursorBlink = config.cursor_blink;
    }
    if (typeof config.mac_option_is_meta !== "undefined") {
        options.macOptionIsMeta = config.mac_option_is_meta;
    }
    if (typeof config.cursor_style !== "undefined") {
        options.cursorStyle = config.cursor_style;
    }
    if (typeof config.cursor_inactive_style !== "undefined") {
        options.cursorInactiveStyle = config.cursor_inactive_style;
    }
    return options;
}

function applyTerminalBackground(config) {
    const background = (config && config.theme && config.theme.background) || null;
    const body = document.querySelector("body");
    if (body) {
        body.style.background = background || "black";
    }
    const terminal = document.getElementById("terminal");
    if (terminal) {
        terminal.style.background = background;
    }
}

function settleFontSize(term, fitAddon, config) {
    const fontSize = config ? config.font_size : undefined;
    const mobileViewport = isMobileViewport();
    const hasExplicitFontSize = typeof fontSize === "number" && fontSize > 0;
    const baseFontPx = hasExplicitFontSize ? fontSize : mobileViewport ? 14 : 12;
    applyFontSize(term, fitAddon, baseFontPx);
    const needsMobileDownscale =
        !hasExplicitFontSize &&
        mobileViewport &&
        term.rows < NATURAL_MIN_TOTAL_ROWS;
    if (needsMobileDownscale) {
        const downscaledPx = Math.max(
            Math.floor((baseFontPx * term.rows) / NATURAL_MIN_TOTAL_ROWS),
            MOBILE_LEGIBLE_FLOOR_PX
        );
        if (downscaledPx < baseFontPx) {
            applyFontSize(term, fitAddon, downscaledPx);
        }
    }
    applyTerminalBackground(config);
}

function initTerminal(config) {
    ensurePreserveDrawingBuffer();
    const term = new Terminal(
        Object.assign(
            {
                fontFamily: NERD_SYMBOLS_FIRST + "Monospace",
                allowProposedApi: true,
                scrollback: 0,
            },
            terminalConfigOptions(config)
        )
    );
    window.term = term;
    const fitAddon = new FitAddon.FitAddon();
    const clipboardAddon = new ClipboardAddon.ClipboardAddon();

    const { linkHandler, activateLink } = build_link_handler();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon(
        activateLink,
        linkHandler
    );
    term.options.linkHandler = linkHandler;

    const webglAddon = new WebglAddon.WebglAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(clipboardAddon);
    term.loadAddon(webLinksAddon);
    webglAddon.onContextLoss((e) => {
        webglAddon.dispose();
    });
    term.loadAddon(webglAddon);
    term.open(document.getElementById("terminal"));
    installWheelHandler(term);
    if (!window.__switchboardManagedFocus) term.focus();
    // The WebGL atlas caches glyphs drawn before the webfont arrived as boxes.
    document.fonts
        .load('12px "Symbols Nerd Font Mono"', "\ue0b0")
        .then(() => term.clearTextureAtlas(), () => {});
    return { term, fitAddon };
}

const MIN_FONT_SIZE_PX = 6;
const MAX_FONT_SIZE_PX = 96;

// A frame that loads display:none measures xterm's floor of 2x1. Attachment workers
// outlive updates, so the browser must not rely on the server's matching has_room:
// an agent that redraws at 2 columns leaves that text in the scrollback for good.
function hasRoom(size) {
    return !!size && size.cols > 2 && size.rows > 1;
}

function applyFontSize(term, fitAddon, requestedPx) {
    const requested =
        typeof requestedPx === "number" && requestedPx > 0
            ? requestedPx
            : term.options.fontSize || 12;
    const effective = clampFontSize(requested);
    if (term.options.fontSize !== effective) {
        term.options.fontSize = effective;
    }
    try {
        if (hasRoom(fitAddon.proposeDimensions())) fitAddon.fit();
    } catch (e) {
    }
}

function clampFontSize(px) {
    const n = Math.round(Number(px) || 0);
    if (n < MIN_FONT_SIZE_PX) return MIN_FONT_SIZE_PX;
    if (n > MAX_FONT_SIZE_PX) return MAX_FONT_SIZE_PX;
    return n;
}
function installImeBypass(term, sendFunction) {
    if (typeof window.__zjImeBypass === "undefined") {
        window.__zjImeBypass = {
            installed: false,
            sendFn: sendFunction,
            lastKeyWasProcess: false,
        };
    }
    window.__zjImeBypass.sendFn = sendFunction;

    if (window.__zjImeBypass.installed) {
        return;
    }
    window.__zjImeBypass.installed = true;
    const state = window.__zjImeBypass;

    document.addEventListener(
        "keydown",
        (ev) => {
            state.lastKeyWasProcess = ev.key === "Process";
        },
        true
    );

    const attach = () => {
        const ta = term && term._core && term._core.textarea;
        if (!ta) {
            setTimeout(attach, 50);
            return;
        }
        ta.addEventListener(
            "input",
            (ev) => {
                if (
                    state.lastKeyWasProcess &&
                    ev.inputType === "insertText" &&
                    !ev.isComposing &&
                    ev.data
                ) {
                    state.sendFn(ev.data);
                    ev.target.value = "";
                    state.lastKeyWasProcess = false;
                }
            },
            true
        );
    };
    attach();
}
function isCoarsePointerDevice() {
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
        return true;
    }
    if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) {
        return true;
    }
    if ("ontouchstart" in window) {
        return true;
    }
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

function installSoftKeyboardCapture(term, sendFunction) {
    if (!isCoarsePointerDevice()) {
        return;
    }
    if (typeof window.__zjSoftKbdCapture === "undefined") {
        window.__zjSoftKbdCapture = {
            installed: false,
            sendFn: sendFunction,
            element: null,
            // document.activeElement returns the shadow host (not the input) for a
            // closed shadow root, so focus state must be mirrored manually.
            isFocused: false,
        };
    }
    window.__zjSoftKbdCapture.sendFn = sendFunction;

    if (window.__zjSoftKbdCapture.installed) {
        return;
    }
    window.__zjSoftKbdCapture.installed = true;
    const state = window.__zjSoftKbdCapture;

    // The capture input steals focus on every tap, so xterm.js renders the cursor
    // with cursorInactiveStyle; mirror the active style so it stays visible.
    const syncInactiveCursorStyle = () => {
        const active = term.options.cursorStyle || "block";
        term.options.cursorInactiveStyle = active;
    };
    syncInactiveCursorStyle();
    window.__zjSyncInactiveCursorStyle = syncInactiveCursorStyle;

    // Firefox Android / GBoard no-op backspace on truly empty content, so keep the
    // input padded with the caret in the middle to give backspace something to delete.
    // Must NOT be a normal space: diff() strips PADDING_CHAR out of the inserted text,
    // which would swallow a genuinely typed space (U+0020). U+00A0 is non-typeable.
    const PADDING_CHAR = "\u00a0";
    const PADDING_LEN = 8;
    const CARET_OFFSET = PADDING_LEN / 2;
    const BASELINE = PADDING_CHAR.repeat(PADDING_LEN);

    const captureHost = document.createElement("div");
    captureHost.id = "zj-mobile-capture-host";
    captureHost.style.cssText =
        "position:fixed;top:0;left:0;" +
        "width:1px;height:1px;" +
        "opacity:0;pointer-events:none;" +
        "overflow:hidden;";
    captureHost.setAttribute("aria-hidden", "true");
    document.body.appendChild(captureHost);
    // Closed shadow root hides the input from page scripts. Extensions can still
    // pierce it (Bitwarden uses chrome.dom.openOrClosedShadowRoot).
    const captureShadow = captureHost.attachShadow({ mode: "closed" });

    const div = document.createElement("input");
    div.id = "zj-mobile-capture";
    // type="password" disables prediction/autocorrect/composition on every mobile
    // keyboard vendor, turning each tap into one immediate character.
    div.type = "password";
    // Bitwarden skips one-time-code fields. "new-password" made it
    // offer to generate a password, and it honors data-bwignore only when opted in.
    div.setAttribute("autocomplete", "one-time-code");
    div.setAttribute("autocorrect", "off");
    div.setAttribute("autocapitalize", "off");
    div.setAttribute("spellcheck", "false");
    div.setAttribute("inputmode", "text");
    div.setAttribute("aria-hidden", "true");
    div.setAttribute("data-1p-ignore", "true");
    div.setAttribute("data-lpignore", "true");
    div.setAttribute("data-bwignore", "true");
    div.setAttribute("data-form-type", "other");
    div.setAttribute("data-dashlane-ignore", "true");
    div.tabIndex = -1;
    // Kept 1x1 transparent rather than hidden: display:none / visibility:hidden
    // would dismiss the OS keyboard.
    div.style.cssText =
        "position:fixed;top:0;left:0;" +
        "width:1px;height:1px;" +
        "opacity:0;pointer-events:none;" +
        "border:0;padding:0;margin:0;" +
        "background:transparent;color:transparent;" +
        "caret-color:transparent;outline:none;" +
        "white-space:pre;overflow:hidden;" +
        "user-select:text;-webkit-user-select:text;";
    captureShadow.appendChild(div);
    state.element = div;

    const emitVisibility = (visible) => {
        window.dispatchEvent(
            new CustomEvent("zellij:soft-keyboard-visibility", {
                detail: { visible },
            })
        );
    };
    div.addEventListener("focus", () => {
        state.isFocused = true;
        emitVisibility(true);
    });
    div.addEventListener("blur", () => {
        state.isFocused = false;
        emitVisibility(false);
    });

    const setCaretToMiddle = () => {
        try {
            const pos = Math.min(CARET_OFFSET, div.value.length);
            div.setSelectionRange(pos, pos);
        } catch (_) {
        }
    };

    const resetBaseline = () => {
        div.value = BASELINE;
        setCaretToMiddle();
    };

    resetBaseline();

    // Some virtual keyboards fire two deleteContentBackward events ~5 ms apart.
    // Debounce only deletions: repeated characters in one insertion are real text.
    let lastDeleteAt = -Infinity;
    const DEDUPE_MS = 8;
    const dispatchBackspace = () => {
        const now = performance.now();
        if (now - lastDeleteAt < DEDUPE_MS) {
            return;
        }
        lastDeleteAt = now;
        state.sendFn("\x7f");
    };

    const diff = (a, b) => {
        const minLen = Math.min(a.length, b.length);
        let prefixLen = 0;
        while (prefixLen < minLen && a[prefixLen] === b[prefixLen]) {
            prefixLen++;
        }
        let suffixLen = 0;
        const maxSuffix = minLen - prefixLen;
        while (
            suffixLen < maxSuffix &&
            a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
        ) {
            suffixLen++;
        }
        const deletedCount = a.length - prefixLen - suffixLen;
        let inserted = b.slice(prefixLen, b.length - suffixLen);
        if (inserted.indexOf(PADDING_CHAR) !== -1) {
            inserted = inserted.split(PADDING_CHAR).join("");
        }
        return { deletedCount, inserted };
    };

    let lastText = BASELINE;

    div.addEventListener("paste", (ev) => {
        if (!ev.clipboardData) return;
        // Password inputs flatten newlines, and input diffing treats pasted NBSP
        // as padding. Use xterm's paste path before the browser edits the field.
        ev.preventDefault();
        if (!term.options.disableStdin) {
            term.paste(ev.clipboardData.getData("text/plain"));
        }
        resetBaseline();
        lastText = BASELINE;
    });

    div.addEventListener("input", (ev) => {
        if (term.options.disableStdin) {
            resetBaseline();
            lastText = BASELINE;
            return;
        }
        const current = div.value;
        if (current === lastText) {
            return;
        }
        const { deletedCount, inserted } = diff(lastText, current);
        for (let i = 0; i < deletedCount; i++) {
            dispatchBackspace();
        }
        if (inserted) {
            state.sendFn(inserted);
        }
        lastText = current;

        if (ev.inputType === "deleteContentBackward") {
            div.value = BASELINE;
            lastText = BASELINE;
            setCaretToMiddle();
        }
    });

    div.addEventListener("keydown", (ev) => {
        if ((ev.code === "KeyC" || ev.key?.toLowerCase() === "c") && ev.ctrlKey &&
            !ev.altKey && !ev.metaKey && !ev.shiftKey && !ev.isComposing &&
            !ev.getModifierState?.("AltGraph")) {
            ev.preventDefault();
            if (!term.options.disableStdin) state.sendFn("\x03");
            resetBaseline();
            lastText = BASELINE;
            return;
        }
        // Touchscreen PCs also use this closed-shadow input with physical keys.
        // Letting Chrome delete words in the password field can consume its
        // left padding and leave the caret at zero, where Backspace emits no input.
        if ((ev.code === "Backspace" || ev.code === "Delete") && ev.cancelable && !ev.isComposing &&
            !ev.metaKey && !ev.shiftKey && !ev.getModifierState?.("AltGraph")) {
            const data = ev.code === "Backspace"
                ? (!ev.ctrlKey && !ev.altKey ? "\x7f" : ev.ctrlKey !== ev.altKey ? "\x17" : null)
                : (!ev.ctrlKey && !ev.altKey ? "\x1b[3~" : null);
            if (data) {
                ev.preventDefault();
                if (!term.options.disableStdin) state.sendFn(data);
                resetBaseline();
                lastText = BASELINE;
                return;
            }
        }
        switch (ev.key) {
            case "Enter":
                ev.preventDefault();
                // Shift+Enter keeps its modifier so agent TUIs insert a newline instead of submitting.
                state.sendFn(ev.shiftKey ? "\x1b[13;2u" : "\r");
                div.value = BASELINE;
                lastText = BASELINE;
                setCaretToMiddle();
                return;
            case "Tab":
                ev.preventDefault();
                state.sendFn("\t");
                return;
            case "Escape":
                ev.preventDefault();
                state.sendFn("\x1b");
                return;
            case "ArrowUp":
                ev.preventDefault();
                state.sendFn("\x1b[A");
                return;
            case "ArrowDown":
                ev.preventDefault();
                state.sendFn("\x1b[B");
                return;
            case "ArrowRight":
                ev.preventDefault();
                state.sendFn("\x1b[C");
                return;
            case "ArrowLeft":
                ev.preventDefault();
                state.sendFn("\x1b[D");
                return;
        }
    });

    // Mobile browsers honor programmatic focus() only inside a user gesture, so
    // re-focus the capture on every gesture to keep the OS keyboard summoned.
    const ensureCaptureFocused = (ev) => {
        if (!window.__zjSoftKbdEnabled) {
            return;
        }
        const target = ev && ev.target;
        if (
            target &&
            typeof target.closest === "function" &&
            target.closest(".zj-mobile-chrome")
        ) {
            return;
        }
        if (state.isFocused) {
            div.blur();
        }
        try {
            div.focus({ preventScroll: true });
        } catch (_) {
            div.focus();
        }
    };
    window.addEventListener("click", ensureCaptureFocused, { passive: true });
    window.addEventListener("touchend", ensureCaptureFocused, { passive: true });
    window.addEventListener("pointerdown", ensureCaptureFocused, {
        capture: true,
        passive: true,
    });
}

// inputmode="none" stops the OS keyboard auto-popping on tap while the textarea
// still processes hardware keypresses.
function suppressSoftKeyboardOnTouch(term) {
    if (window.__zjSoftKbdSuppressed) {
        return;
    }
    if (!isCoarsePointerDevice()) {
        return;
    }
    window.__zjSoftKbdSuppressed = true;
    window.__zjSoftKbdEnabled = true;
    const apply = () => {
        const ta = term && term._core && term._core.textarea;
        if (!ta) {
            setTimeout(apply, 50);
            return;
        }
        ta.setAttribute("inputmode", "none");
    };
    apply();
}

function setSoftKeyboard(term, on) {
    if (!isCoarsePointerDevice()) {
        return;
    }
    const ta = term && term._core && term._core.textarea;
    if (!ta) {
        return;
    }
    if (window.__zjSoftKbdEnabled === on) {
        return;
    }
    window.__zjSoftKbdEnabled = on;
    const capture = window.__zjSoftKbdCapture && window.__zjSoftKbdCapture.element;
    if (on) {
        if (capture) {
            capture.focus();
        } else {
            ta.removeAttribute("inputmode");
            ta.focus();
        }
    } else {
        if (capture) {
            capture.blur();
        }
        ta.setAttribute("inputmode", "none");
        ta.focus();
    }
}

function toggleSoftKeyboard(term) {
    setSoftKeyboard(term, !window.__zjSoftKbdEnabled);
}

function installCustomKeyHandler(term, sendFunction) {
    term.attachCustomKeyEventHandler((ev) => {
        if (ev.type === "keydown") {
            if (ev.key == "V" && ev.ctrlKey && ev.shiftKey) {
                return;
            }
            if (isMac() && ev.key == "v" && ev.metaKey) {
                return;
            }
            // Leave Cmd+1-9 (tab switching) and Cmd+R / Cmd+Shift+R (reload) to the
            // browser: no preventDefault, no xterm.
            if (ev.metaKey && !ev.ctrlKey && !ev.altKey &&
                ((!ev.shiftKey && /^Digit[1-9]$/.test(ev.code)) || ev.code === 'KeyR')) {
                return false;
            }
            // Windows browser tab switching must also bypass xterm when the
            // native web client is opened without the sidebar bridge.
            if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey &&
                /^Digit[1-9]$/.test(ev.code) && navigator.platform.startsWith('Win')) {
                return false;
            }
            // Keep this at the terminal handler as well as the sidebar bridge:
            // xterm's Ctrl+Backspace is ^H, which enters Zellij's Move mode and
            // prevents later Backspace/Delete from reaching the shell.
            if (ev.key === "Backspace" && (ev.ctrlKey !== ev.altKey) &&
                !ev.metaKey && !ev.shiftKey && !ev.isComposing &&
                !ev.getModifierState?.("AltGraph")) {
                ev.preventDefault();
                sendFunction("\x17");
                return false;
            }
            // xterm.js sends a bare CR for Ctrl+Enter, dropping the modifier.
            if (hasModifiersToHandle(ev) || ((ev.ctrlKey || ev.shiftKey) && ev.key == "Enter")) {
                ev.preventDefault();
                encode_kitty_key(ev, sendFunction);
                return false;
            }
            // xterm.js mishandles Alt+Arrow; send Alt-modified SGR sequences directly:
            // https://github.com/xtermjs/xterm.js/blob/41e8ae395937011d6bf6c7cb618b851791aed395/src/common/input/Keyboard.ts#L158
            if (ev.key == "ArrowLeft" && ev.altKey) {
                ev.preventDefault();
                sendFunction("\x1b[1;3D");
                return false;
            }
            if (ev.key == "ArrowRight" && ev.altKey) {
                ev.preventDefault();
                sendFunction("\x1b[1;3C");
                return false;
            }
            if (ev.key == "ArrowUp" && ev.altKey) {
                ev.preventDefault();
                sendFunction("\x1b[1;3A");
                return false;
            }
            if (ev.key == "ArrowDown" && ev.altKey) {
                ev.preventDefault();
                sendFunction("\x1b[1;3B");
                return false;
            }
            if (
                (ev.key == "=" && ev.altKey) ||
                (ev.key == "+" && ev.altKey) ||
                (ev.key == "-" && ev.altKey)
            ) {
                ev.preventDefault();
                encode_kitty_key(ev, sendFunction);
                return false;
            }
        }
        return true;
    });
}

function hasModifiersToHandle(ev) {
    const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta"];
    const modifiers_count = [
        ev.altKey,
        ev.ctrlKey,
        ev.shiftKey,
        ev.metaKey,
    ].filter(Boolean).length;
    const isModifierKey = MODIFIER_KEYS.includes(ev.key);
    return (modifiers_count > 1 || ev.metaKey) && !isModifierKey;
}
function installMouseHandlers(term, terminalElement, sendFunction) {
    let prev_col = 0;
    let prev_row = 0;

    // xterm.js doesn't emit mousemove (xtermjs/xterm.js#1062); synthesize SGR motion reports.
    terminalElement.addEventListener("mousemove", function (event) {
        if (event.buttons == 0) {
            let coordEvent = event;
            if (window.__zjMobilePan && window.__zjMobilePan.isActive()) {
                const off = window.__zjMobilePan.getOffset();
                coordEvent = {
                    clientX: event.clientX + off.x,
                    clientY: event.clientY + off.y,
                };
            }
            const { col, row } = term._core._mouseService.getMouseReportCoords(
                coordEvent,
                terminalElement
            );
            if (prev_col != col || prev_row != row) {
                sendFunction(`\x1b[<35;${col + 1};${row + 1}M`);
            }
            prev_col = col;
            prev_row = row;
        }
    });

    document.addEventListener("contextmenu", function (event) {
        if (event.altKey) {
            event.preventDefault();
        }
    });
}

// xterm.js's WebGL renderer clears the framebuffer when it reassigns
// canvas.width/height on a font-size change, and during a touch gesture the
// repaint is rAF-throttled, so the cleared canvas can flash blank before the
// repaint lands. This overlay pins a 2d-canvas snapshot over the live canvas.
function createPinchController(term) {
    let pinchOverlay = null;
    let pinchOverlayAwaitingRender = false;
    let pinchOverlaySafetyTimer = null;

    const destroy = () => {
        if (pinchOverlay) {
            pinchOverlay.remove();
            pinchOverlay = null;
        }
        pinchOverlayAwaitingRender = false;
        if (pinchOverlaySafetyTimer !== null) {
            clearTimeout(pinchOverlaySafetyTimer);
            pinchOverlaySafetyTimer = null;
        }
    };

    const snapshot = () => {
        destroy();
        if (!term.element) return;
        const sourceCanvases = term.element.querySelectorAll("canvas");
        if (sourceCanvases.length === 0) return;
        const ref = sourceCanvases[0];
        const rect = ref.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const overlay = document.createElement("canvas");
        overlay.width = ref.width;
        overlay.height = ref.height;
        const outer = document.getElementById("terminal");
        const bg = outer
            ? window.getComputedStyle(outer).backgroundColor
            : "transparent";
        Object.assign(overlay.style, {
            position: "fixed",
            left: rect.left + "px",
            top: rect.top + "px",
            width: rect.width + "px",
            height: rect.height + "px",
            zIndex: "9999",
            pointerEvents: "none",
            background: bg,
        });

        const ctx = overlay.getContext("2d");
        if (ctx) {
            for (const c of sourceCanvases) {
                try {
                    ctx.drawImage(c, 0, 0);
                } catch (e) {
                }
            }
        }

        document.body.appendChild(overlay);
        pinchOverlay = overlay;
    };

    const refresh = () => {
        if (!pinchOverlay) return;
        if (!term.element) return;
        const sourceCanvases = term.element.querySelectorAll("canvas");
        if (sourceCanvases.length === 0) return;
        const ref = sourceCanvases[0];
        const rect = ref.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        if (pinchOverlay.width !== ref.width) {
            pinchOverlay.width = ref.width;
        }
        if (pinchOverlay.height !== ref.height) {
            pinchOverlay.height = ref.height;
        }
        pinchOverlay.style.left = rect.left + "px";
        pinchOverlay.style.top = rect.top + "px";
        pinchOverlay.style.width = rect.width + "px";
        pinchOverlay.style.height = rect.height + "px";

        const ctx = pinchOverlay.getContext("2d");
        if (ctx) {
            ctx.clearRect(0, 0, pinchOverlay.width, pinchOverlay.height);
            for (const c of sourceCanvases) {
                try {
                    ctx.drawImage(c, 0, 0);
                } catch (e) {
                }
            }
        }
    };

    const armRemoval = () => {
        if (!pinchOverlay) return;
        pinchOverlayAwaitingRender = true;
        if (pinchOverlaySafetyTimer !== null) {
            clearTimeout(pinchOverlaySafetyTimer);
        }
        pinchOverlaySafetyTimer = setTimeout(() => {
            pinchOverlaySafetyTimer = null;
            destroy();
        }, 600);
    };

    // Must not call fitAddon.fit() here: that would pre-sync term.rows/cols to the
    // new dims, making the resize handler short-circuit and never notify the server.
    const applyFontSize = (px) => {
        const clamped = clampFontSize(px);
        if (term.options.fontSize === clamped) {
            return;
        }
        term.options.fontSize = clamped;
        window.dispatchEvent(new CustomEvent("zellij:rendering-resize"));
    };

    if (term && typeof term.onRender === "function") {
        term.onRender(() => {
            if (!pinchOverlay) return;
            refresh();
            if (pinchOverlayAwaitingRender) {
                pinchOverlayAwaitingRender = false;
                requestAnimationFrame(() => {
                    destroy();
                });
            }
        });
    }

    return { snapshot, refresh, applyFontSize, armRemoval, destroy };
}
let term = null;
let containerEl = null;
let panX = 0;
let panY = 0;
let active = false;

function getScreenEl() {
    if (!term || !term.element) {
        return null;
    }
    return term.element;
}

function cellDims() {
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
    return null;
}

function contentSize() {
    const cell = cellDims();
    if (!cell) {
        return null;
    }
    return {
        width: cell.width * term.cols,
        height: cell.height * term.rows,
    };
}

function containerSize() {
    if (!containerEl) {
        return { width: 0, height: 0 };
    }
    const rect = containerEl.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
}

function bounds() {
    const content = contentSize();
    if (!content) {
        return { maxX: 0, maxY: 0 };
    }
    const view = containerSize();
    return {
        maxX: Math.max(0, content.width - view.width),
        maxY: Math.max(0, content.height - view.height),
    };
}

function clamp() {
    const b = bounds();
    if (panX > b.maxX) panX = b.maxX;
    if (panY > b.maxY) panY = b.maxY;
    if (panX < 0) panX = 0;
    if (panY < 0) panY = 0;
}

function applyTransform() {
    const el = getScreenEl();
    if (!el) {
        return;
    }
    if (active) {
        el.style.transform = `translate3d(${-panX}px, ${-panY}px, 0)`;
        el.style.transformOrigin = "top left";
        el.style.willChange = "transform";
    } else {
        el.style.transform = "";
        el.style.willChange = "";
    }
}

function setActive(on) {
    const next = !!on;
    if (next === active) {
        if (active) {
            clamp();
            applyTransform();
        }
        return;
    }
    active = next;
    if (!active) {
        panX = 0;
        panY = 0;
    }
    document.body.classList.toggle("zj-mobile-panning", active);
    clamp();
    applyTransform();
}

function panBy(dx, dy) {
    if (!active) {
        return;
    }
    panX += dx;
    panY += dy;
    clamp();
    applyTransform();
}

function recompute() {
    if (!active) {
        return;
    }
    clamp();
    applyTransform();
}

function initMobilePan(context) {
    term = context.term;
    containerEl = document.getElementById("terminal");
    if (window.__zjMobilePan) {
        return window.__zjMobilePan;
    }
    window.__zjMobilePan = {
        setActive,
        panBy,
        recompute,
        isActive: () => active,
        getOffset: () => ({ x: panX, y: panY }),
    };
    window.addEventListener("resize", recompute);
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", recompute);
    }
    window.addEventListener("zellij:rendering-resize", () => {
        requestAnimationFrame(recompute);
    });
    return window.__zjMobilePan;
}

const SGR_COORD_BASE = 1;
const panActive = () =>
    !!(window.__zjMobilePan && window.__zjMobilePan.isActive());
function installTouchGestures({ term, terminalElement, sendFunction, pinch }) {
    let last_touch_y = null;
    let last_touch_x = null;
    let pending_scroll = 0;
    let pending_h_scroll = 0;
    let touch_origin = null;
    let touch_moved = false;
    let long_press_fired = false;
    let long_press_timer = null;
    let two_finger_gesture_t = null;
    let pinch_initial_distance = null;
    let pinch_initial_font_size = null;
    let pinch_active = false;

    const touch_scroll_threshold = 24;
    const click_move_threshold = 16;
    const long_press_duration_ms = 500;
    const two_finger_tap_max_ms = 600;
    const pinch_activation_threshold = 18;

    const reportCoords = (clientX, clientY) => {
        let x = clientX;
        let y = clientY;
        if (panActive()) {
            const off = window.__zjMobilePan.getOffset();
            x += off.x;
            y += off.y;
        }
        return term._core._mouseService.getMouseReportCoords(
            { clientX: x, clientY: y },
            terminalElement
        );
    };

    const cancelLongPress = () => {
        if (long_press_timer !== null) {
            clearTimeout(long_press_timer);
            long_press_timer = null;
        }
    };

    const sendSgrButton = (button, col, row) => {
        const sgrCol = col + SGR_COORD_BASE;
        const sgrRow = row + SGR_COORD_BASE;
        sendFunction(`\x1b[<${button};${sgrCol};${sgrRow}M`);
        sendFunction(`\x1b[<${button};${sgrCol};${sgrRow}m`);
    };

    const sendWheelEvent = (direction, touch) => {
        const { col, row } = reportCoords(touch.clientX, touch.clientY);
        const swipedUp = direction < 0;
        const button = swipedUp ? 65 : 64;
        sendFunction(`\x1b[<${button};${col + SGR_COORD_BASE};${row + SGR_COORD_BASE}M`);
    };

    // Scroll direction follows the content, not the finger: swiping the content
    // leftward reveals the right edge, so finger-left maps to wheel-right.
    const sendHorizontalWheelEvent = (direction, touch) => {
        const { col, row } = reportCoords(touch.clientX, touch.clientY);
        const button = direction < 0 ? 66 : 67;
        sendFunction(`\x1b[<${button};${col + SGR_COORD_BASE};${row + SGR_COORD_BASE}M`);
    };

    const touchPairDistance = (touches) => {
        if (touches.length < 2) {
            return 0;
        }
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.hypot(dx, dy);
    };

    terminalElement.addEventListener(
        "touchstart",
        (event) => {
            if (event.touches.length === 2 && two_finger_gesture_t === null) {
                event.preventDefault();
                two_finger_gesture_t = performance.now();
                cancelLongPress();
                touch_origin = null;
                touch_moved = false;
                long_press_fired = false;
                pinch_initial_distance = touchPairDistance(event.touches);
                pinch_initial_font_size = clampFontSize(
                    term.options.fontSize || 16
                );
                pinch_active = false;
                return;
            }
            if (two_finger_gesture_t !== null) {
                event.preventDefault();
                return;
            }
            if (event.touches.length > 0) {
                // iOS/Android honor focus() as a keyboard summon only inside a
                // still-active, not-yet-prevented gesture, so this must precede
                // the preventDefault below.
                if (
                    window.__zjSoftKbdEnabled &&
                    window.__zjSoftKbdCapture &&
                    window.__zjSoftKbdCapture.element &&
                    !window.__zjSoftKbdCapture.isFocused
                ) {
                    try {
                        window.__zjSoftKbdCapture.element.focus({
                            preventScroll: true,
                        });
                    } catch (_) {
                        window.__zjSoftKbdCapture.element.focus();
                    }
                }
                // preventDefault on touchstart cancels the synthetic mouse cascade
                // browsers fire ~300 ms later, which would otherwise make xterm.js
                // send a second SGR click for the same gesture.
                event.preventDefault();
                const touch = event.touches[0];
                last_touch_y = touch.clientY;
                last_touch_x = touch.clientX;
                pending_scroll = 0;
                pending_h_scroll = 0;
                // Capture cell coords now: on iOS the soft keyboard sliding up
                // between touchstart and touchend re-fits the grid.
                const { col, row } = reportCoords(touch.clientX, touch.clientY);
                touch_origin = {
                    x: touch.clientX,
                    y: touch.clientY,
                    col,
                    row,
                    t: performance.now(),
                };
                touch_moved = false;
                long_press_fired = false;
                cancelLongPress();
                long_press_timer = setTimeout(() => {
                    long_press_timer = null;
                    if (touch_origin === null || touch_moved) {
                        return;
                    }
                    long_press_fired = true;
                    sendSgrButton(2, touch_origin.col, touch_origin.row);
                    if (typeof navigator.vibrate === "function") {
                        navigator.vibrate(10);
                    }
                }, long_press_duration_ms);
            }
        },
        { passive: false }
    );

    terminalElement.addEventListener(
        "touchmove",
        (event) => {
            if (
                event.touches.length === 2 &&
                pinch_initial_distance !== null &&
                pinch_initial_distance > 0
            ) {
                event.preventDefault();
                const dist = touchPairDistance(event.touches);
                if (
                    !pinch_active &&
                    Math.abs(dist - pinch_initial_distance) >
                        pinch_activation_threshold
                ) {
                    pinch_active = true;
                    pinch.snapshot();
                }
                if (pinch_active) {
                    const ratio = dist / pinch_initial_distance;
                    pinch.applyFontSize(pinch_initial_font_size * ratio);
                }
                return;
            }

            if (event.touches.length === 0 || last_touch_y === null) {
                return;
            }
            event.preventDefault();
            const touch = event.touches[0];

            if (touch_origin !== null && !touch_moved) {
                const dx = touch.clientX - touch_origin.x;
                const dy = touch.clientY - touch_origin.y;
                if (Math.hypot(dx, dy) > click_move_threshold) {
                    touch_moved = true;
                    cancelLongPress();
                }
            }

            const delta_y = touch.clientY - last_touch_y;
            const delta_x =
                last_touch_x === null ? 0 : touch.clientX - last_touch_x;
            last_touch_y = touch.clientY;
            last_touch_x = touch.clientX;

            if (panActive()) {
                window.__zjMobilePan.panBy(-delta_x, -delta_y);
                return;
            }

            pending_scroll += delta_y;
            pending_h_scroll += delta_x;
            while (pending_scroll <= -touch_scroll_threshold) {
                sendWheelEvent(-1, touch);
                pending_scroll += touch_scroll_threshold;
            }
            while (pending_scroll >= touch_scroll_threshold) {
                sendWheelEvent(1, touch);
                pending_scroll -= touch_scroll_threshold;
            }
            while (pending_h_scroll <= -touch_scroll_threshold) {
                sendHorizontalWheelEvent(-1, touch);
                pending_h_scroll += touch_scroll_threshold;
            }
            while (pending_h_scroll >= touch_scroll_threshold) {
                sendHorizontalWheelEvent(1, touch);
                pending_h_scroll -= touch_scroll_threshold;
            }
        },
        { passive: false }
    );

    terminalElement.addEventListener(
        "touchend",
        (event) => {
            if (two_finger_gesture_t !== null && event.touches.length === 0) {
                const elapsed = performance.now() - two_finger_gesture_t;
                const wasPinch = pinch_active;
                two_finger_gesture_t = null;
                pinch_active = false;
                pinch_initial_distance = null;
                pinch_initial_font_size = null;
                if (wasPinch) {
                    pinch.armRemoval();
                    return;
                }
                if (elapsed < two_finger_tap_max_ms) {
                    toggleSoftKeyboard(term);
                }
                return;
            }
            cancelLongPress();
            if (touch_origin !== null && !touch_moved && !long_press_fired) {
                sendSgrButton(0, touch_origin.col, touch_origin.row);
            }
            last_touch_y = null;
            last_touch_x = null;
            pending_scroll = 0;
            pending_h_scroll = 0;
            touch_origin = null;
            touch_moved = false;
            long_press_fired = false;
        },
        { passive: true }
    );

    terminalElement.addEventListener(
        "touchcancel",
        () => {
            cancelLongPress();
            last_touch_y = null;
            last_touch_x = null;
            pending_scroll = 0;
            pending_h_scroll = 0;
            touch_origin = null;
            touch_moved = false;
            long_press_fired = false;
            two_finger_gesture_t = null;
            pinch_initial_distance = null;
            pinch_initial_font_size = null;
            pinch_active = false;
            pinch.destroy();
        },
        { passive: true }
    );
}


function setupInputHandlers(term, fitAddon, sendFunction) {
    installImeBypass(term, sendFunction);
    installSoftKeyboardCapture(term, sendFunction);
    suppressSoftKeyboardOnTouch(term);
    installCustomKeyHandler(term, sendFunction);

    const terminalElement = document.getElementById("terminal");
    initMobilePan({ term });
    installMouseHandlers(term, terminalElement, sendFunction);

    const pinch = createPinchController(term);
    installTouchGestures({ term, terminalElement, sendFunction, pinch });

    term.onData((data) => {
        sendFunction(data);
    });

    term.onBinary((data) => {
        const buffer = new Uint8Array(data.length);
        for (let i = 0; i < data.length; ++i) {
            buffer[i] = data.charCodeAt(i) & 255;
        }
        sendFunction(buffer);
    });
}

const DARK_PALETTE = {
    "--zj-green": "#A3BD8D",
    "--zj-blue": "#7E9FBE",
    "--zj-yellow": "#EACB8B",
    "--zj-red": "#BE616B",
    "--zj-bg": "#000000",
    "--zj-surface": "#1C1C1C",
    "--zj-border": "#3A3A3A",
    "--zj-text": "#FFFFFF",
    "--zj-text-dim": "#CCCCCC",
};

const LIGHT_PALETTE = {
    "--zj-green": "#4F6B41",
    "--zj-blue": "#3E6183",
    "--zj-yellow": "#8A6A17",
    "--zj-red": "#A0323E",
    "--zj-bg": "#FFFFFF",
    "--zj-surface": "#F0F0F0",
    "--zj-border": "#CCCCCC",
    "--zj-text": "#000000",
    "--zj-text-dim": "#666666",
};

function paletteDeclarations(palette) {
    return Object.entries(palette)
        .map(([name, value]) => `${name}: ${value};`)
        .join("\n      ");
}

const state = {
    active: false,
    standalone: false,
    renderMode: "full",
    initialPrefsSent: false,
    fitEnabled: true,
    activeOverlay: "none",
    armed: { ctrl: false, alt: false },
    kbdVisible: false,
    data: emptyMobileState(),
    dataReceivedAt: 0,
};

let ctx = null;
let els = null;
let activityTimer = null;
let initialized = false;
let standalone = null;

function initMobileUi(context) {
    ctx = context;
    if (initialized) {
        return;
    }
    initialized = true;
    injectStyles();
    applyThemePreference();
    buildDom();
    installMenuDismissHook();
    installKeyMergeHook();
    installSoftKeyboardBinding();
    installResizeReconcileHooks();
    evaluateActivation();
    window.addEventListener("resize", evaluateActivation);
    window.__zjMobileUi = {
        setData,
        getState: () => state,
        getRenderSizing,
    };
    if (window.__zjLastMobileState) {
        setData(window.__zjLastMobileState);
    }
}

const ACTIVATION_PREFERENCE_KEY = "zellij:mobile-ui";

function activationPreference() {
    try {
        const stored = localStorage.getItem(ACTIVATION_PREFERENCE_KEY);
        if (stored === "on") return "on";
        if (stored === "off") return "off";
        return "auto";
    } catch (_) {
        return "auto";
    }
}

function setActivationPreference(value) {
    try {
        localStorage.setItem(ACTIVATION_PREFERENCE_KEY, value);
    } catch (_) {}
}

const THEME_PREFERENCE_KEY = "zellij:mobile-theme";


function themePreference() {
    try {
        const stored = localStorage.getItem(THEME_PREFERENCE_KEY);
        if (stored === "light") return "light";
        if (stored === "dark") return "dark";
        return "auto";
    } catch (_) {
        return "auto";
    }
}

function setThemePreference(value) {
    try {
        localStorage.setItem(THEME_PREFERENCE_KEY, value);
    } catch (_) {}
}

function applyThemePreference() {
    const preference = themePreference();
    if (preference === "auto") {
        document.documentElement.removeAttribute("data-zj-theme");
    } else {
        document.documentElement.setAttribute("data-zj-theme", preference);
    }
}

function effectiveTheme() {
    const preference = themePreference();
    if (preference !== "auto") {
        return preference;
    }
    try {
        return window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark";
    } catch (_) {
        return "dark";
    }
}

function toggleThemePreference() {
    setThemePreference(effectiveTheme() === "light" ? "dark" : "light");
    applyThemePreference();
}

function shouldActivate() {
    const preference = activationPreference();
    if (preference === "on") return true;
    if (preference === "off") return false;
    return isMobileViewport();
}

// A mobile client landing on the root URL gets the session menu instead of a session: the
// welcome screen is a poor first screen on a phone, and booting one just to switch away from it
// leaves an abandoned session behind.
function shouldUseStandaloneMenu() {
    return shouldActivate();
}

const STANDALONE_REFRESH_MS = 3000;

/**
 * Take over the page with the session switcher before any session exists.
 * @param {Object} options - `{ fetchSessions }` returning a promise of session descriptors
 * @returns {Promise<Object>} resolves once the user asks for a new unnamed session
 */
function showStandaloneSessionMenu({ fetchSessions }) {
    injectStyles();
    buildDom();
    state.standalone = true;
    state.data = emptyMobileState();
    state.data.is_welcome_screen = true;
    state.dataReceivedAt = Date.now();
    document.body.classList.add("zj-mobile-standalone");
    installResizeReconcileHooks();
    updateStandaloneViewportVars();

    return new Promise((resolve) => {
        standalone = { resolve, fetchSessions, refreshTimer: null };
        openOverlay("sessions");
        refreshStandaloneSessions();
        standalone.refreshTimer = setInterval(
            refreshStandaloneSessions,
            STANDALONE_REFRESH_MS
        );
    });
}

async function refreshStandaloneSessions() {
    if (!standalone) {
        return;
    }
    try {
        const sessions = await standalone.fetchSessions();
        if (!standalone) {
            return;
        }
        state.data.sessions = sessions;
        state.data.now_secs = Math.floor(Date.now() / 1000);
        state.dataReceivedAt = Date.now();
        render();
    } catch (_) {}
}

function finishStandalone(outcome) {
    if (!standalone) {
        return;
    }
    const { resolve, refreshTimer } = standalone;
    standalone = null;
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    state.standalone = false;
    state.activeOverlay = "none";
    state.data = emptyMobileState();
    stopActivityTimer();
    document.body.classList.remove("zj-mobile-standalone");
    render();
    resolve(outcome);
}

function evaluateActivation() {
    const next = shouldActivate();
    if (next === state.active) {
        renderReturnPill();
        return;
    }
    state.active = next;
    document.body.classList.toggle("zj-mobile-active", next);
    if (!next) {
        state.activeOverlay = "none";
        state.kbdVisible = false;
        stopActivityTimer();
    }
    if (next) {
        sendInitialRenderPrefs();
    }
    render();
    updateKeyboardOffset();
    reconcileSize();
}

// The mobile UI opens in single-pane mode. The server cannot decide this on its own: every
// browser is a web client, but only this UI knows whether it activated, so the intent is sent
// from here once the control channel exists.
function sendInitialRenderPrefs() {
    if (state.initialPrefsSent || !state.active || !window.__zjSendControl) {
        return false;
    }
    state.initialPrefsSent = true;
    // A follower pans the owner's complete layout. Activation must not fullscreen everyone.
    state.renderMode = window.__zjViewport?.getSizing()?.pinned ? "full" : "single-pane";
    state.fitEnabled = true;
    sendRenderPrefs();
    return true;
}

function setData(data) {
    const prevDesktop = state.data.desktop_size;
    state.data = data;
    state.dataReceivedAt = Date.now();
    // A payload that predates the initial intent describes the state before it was applied, so
    // reconciling against it would flip the UI out of single-pane for a frame.
    if (!sendInitialRenderPrefs()) {
        reconcileRenderPrefs(data.render_prefs);
    }
    if (!state.fitEnabled && desktopSizeChanged(prevDesktop, data.desktop_size)) {
        window.dispatchEvent(new Event("zellij:rendering-resize"));
    }
    requestAnimationFrame(syncPan);
    render();
}

function desktopSizeChanged(a, b) {
    if (!a && !b) return false;
    if (!a || !b) return true;
    return a.cols !== b.cols || a.rows !== b.rows;
}

function reconcileRenderPrefs(prefs) {
    if (!prefs) {
        return;
    }
    const nextRenderMode = prefs.single_pane ? "single-pane" : "full";
    const changed =
        state.renderMode !== nextRenderMode || state.fitEnabled !== prefs.fit;
    state.renderMode = nextRenderMode;
    state.fitEnabled = prefs.fit;
    if (changed) {
        reconcileSize();
    }
}

function nowSecs() {
    const base = state.data.now_secs || Math.floor(Date.now() / 1000);
    const driftMs = state.dataReceivedAt ? Date.now() - state.dataReceivedAt : 0;
    return base + Math.floor(driftMs / 1000);
}

function injectStyles() {
    if (document.querySelector("#zj-mobile-styles")) {
        return;
    }
    const style = document.createElement("style");
    style.id = "zj-mobile-styles";
    style.textContent = `
    :root {
      ${paletteDeclarations(DARK_PALETTE)}
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-zj-theme="dark"]) {
        ${paletteDeclarations(LIGHT_PALETTE)}
      }
    }
    :root[data-zj-theme="light"] {
      ${paletteDeclarations(LIGHT_PALETTE)}
    }

    #zj-mobile-root {
      font-family: 'JetBrains Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
      display: none;
    }
    body.zj-mobile-active #zj-mobile-root { display: block; }

    body.zj-mobile-active #terminal {
      height: calc(var(--dynamic-vh, 100vh) - var(--zj-chrome-top, 0px) - var(--zj-chrome-bottom, 0px));
      margin-top: var(--zj-chrome-top, 0px);
    }

    body.zj-mobile-panning #terminal {
      touch-action: none;
    }

    .zj-mobile-return {
      display: none;
      position: fixed; right: 12px; bottom: 12px;
      z-index: 700;
      min-height: 44px; padding: 0 16px;
      border: 1px solid var(--zj-green);
      border-radius: 22px;
      background: var(--zj-surface);
      color: var(--zj-text);
      font-family: 'JetBrains Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 14px;
      cursor: pointer;
    }
    body.zj-mobile-active .zj-mobile-return { display: none !important; }

    body.zj-mobile-standalone #zj-mobile-root { display: block; }
    body.zj-mobile-standalone .zj-mobile-topbar,
    body.zj-mobile-standalone .zj-mobile-modbar,
    body.zj-mobile-standalone .zj-mobile-menu,
    body.zj-mobile-standalone .zj-mobile-return { display: none !important; }
    body.zj-mobile-standalone #terminal { visibility: hidden; }

    .zj-mobile-empty {
      color: var(--zj-text-dim); font-size: 14px;
      padding: 24px 4px; text-align: center;
    }

    .zj-mobile-topbar {
      position: fixed; top: 0; left: 0; right: 0;
      display: flex; align-items: stretch;
      height: 44px; z-index: 500;
      background: var(--zj-bg);
      border-bottom: 1px solid var(--zj-green);
      color: var(--zj-text);
    }
    .zj-mobile-topbar button {
      background: transparent; border: 0; color: inherit;
      font-family: inherit; font-size: 14px;
      padding: 0 12px; cursor: pointer;
      display: flex; align-items: center;
      min-height: 44px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .zj-mobile-topbar .zj-session { color: var(--zj-blue); }
    .zj-mobile-topbar .zj-pane { color: var(--zj-green); flex: 1 1 auto; min-width: 0; }
    .zj-mobile-topbar .zj-hamburger {
      color: var(--zj-yellow); font-size: 20px;
      flex: 0 0 auto; min-width: 44px; justify-content: center;
    }

    .zj-mobile-modbar {
      position: fixed; left: 0; right: 0;
      bottom: var(--zj-kbd-offset, 0px);
      display: none; z-index: 500;
      background: var(--zj-surface);
      border-top: 1px solid var(--zj-green);
    }
    body.zj-mobile-active .zj-mobile-modbar.zj-visible { display: flex; }
    .zj-mobile-modbar button {
      flex: 1 1 0; min-width: 0;
      background: transparent; border: 0;
      border-right: 1px solid var(--zj-border);
      color: var(--zj-text); font-family: inherit; font-size: 15px;
      min-height: 48px; cursor: pointer;
    }
    .zj-mobile-modbar button:last-child { border-right: 0; }
    .zj-mobile-modbar button.zj-armed {
      background: var(--zj-green); color: var(--zj-bg); font-weight: 600;
    }

    .zj-mobile-menu {
      position: fixed; top: 44px; right: 0; z-index: 600;
      min-width: 220px; max-width: 90vw;
      background: var(--zj-bg);
      border: 1px solid var(--zj-green);
      display: none; flex-direction: column;
    }
    .zj-mobile-menu.zj-open { display: flex; }
    .zj-mobile-menu button {
      background: transparent; border: 0; color: var(--zj-text);
      font-family: inherit; font-size: 14px; text-align: left;
      padding: 14px 16px; min-height: 48px; cursor: pointer;
    }
    .zj-mobile-menu button:hover { background: var(--zj-surface); }
    .zj-mobile-menu button.zj-disabled {
      color: var(--zj-text-dim); opacity: 0.5; cursor: default;
    }
    .zj-mobile-menu .zj-sep {
      height: 1px; background: var(--zj-border); margin: 4px 0;
    }

    .zj-mobile-overlay {
      position: fixed; top: 0; left: 0; right: 0; z-index: 700;
      height: var(--dynamic-vh, 100vh);
      max-height: var(--dynamic-vh, 100vh);
      background: var(--zj-bg); color: var(--zj-text);
      display: none; flex-direction: column; overflow: hidden;
    }
    .zj-mobile-overlay.zj-open { display: flex; }
    .zj-mobile-overlay-header {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--zj-border);
    }
    .zj-mobile-overlay-header .zj-back {
      background: transparent; border: 1px solid var(--zj-border);
      color: var(--zj-text); font-family: inherit; font-size: 14px;
      padding: 8px 12px; min-height: 40px; cursor: pointer;
    }
    .zj-mobile-overlay-header .zj-title {
      color: var(--zj-blue); font-size: 16px; font-weight: 600;
    }
    .zj-mobile-search-row {
      flex: 0 0 auto;
      display: flex; align-items: baseline; gap: 8px;
      margin: 10px 12px 0 12px;
      border-bottom: 1px solid var(--zj-border);
    }
    .zj-mobile-search-row .zj-search-label {
      flex: 0 0 auto;
      color: var(--zj-blue); font-size: 15px; font-weight: 600;
    }
    .zj-mobile-overlay input.zj-search, .zj-mobile-overlay input.zj-name {
      flex: 1 1 auto; min-width: 0;
      margin: 0; padding: 10px 0; box-sizing: border-box;
      background: transparent; color: var(--zj-text);
      border: 0; font-family: inherit; font-size: 15px;
    }
    .zj-mobile-overlay input.zj-search:focus,
    .zj-mobile-overlay input.zj-name:focus { outline: none; }
    .zj-mobile-hint {
      flex: 0 0 auto;
      color: var(--zj-text-dim); font-size: 13px;
      margin: 8px 12px 0 12px;
    }
    /* min-height:0 is what lets this shrink below its content in the flex column;
       without it the card list pushes the footer past the bottom of the screen. */
    .zj-mobile-cards {
      flex: 1 1 auto; min-height: 0;
      overflow-y: auto; -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain; touch-action: pan-y;
      padding: 0 12px;
    }
    .zj-mobile-card {
      background: var(--zj-surface);
      border: 1px solid var(--zj-border);
      padding: 12px; margin-bottom: 8px; cursor: pointer;
    }
    .zj-mobile-card .zj-card-title { color: var(--zj-green); font-size: 15px; }
    .zj-mobile-card .zj-card-title .zj-match { color: var(--zj-yellow); }
    .zj-mobile-card .zj-card-meta { color: var(--zj-text-dim); font-size: 13px; margin-top: 4px; }
    .zj-mobile-footer {
      flex: 0 0 auto;
      display: flex; gap: 8px; padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--zj-border);
      background: var(--zj-bg);
    }
    .zj-mobile-footer button {
      flex: 1 1 0; background: transparent;
      border: 1px solid var(--zj-green); color: var(--zj-green);
      font-family: inherit; font-size: 14px; min-height: 44px; cursor: pointer;
    }
    .zj-mobile-prompt-buttons {
      flex: 0 0 auto; display: flex; gap: 8px; padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }
    .zj-mobile-prompt-buttons button {
      flex: 1 1 0; font-family: inherit; font-size: 14px; min-height: 44px;
      background: transparent; cursor: pointer;
    }
    .zj-mobile-prompt-buttons .zj-cancel { border: 1px solid var(--zj-red); color: var(--zj-red); }
    .zj-mobile-prompt-buttons .zj-accept { border: 1px solid var(--zj-green); color: var(--zj-green); }
    `;
    document.head.appendChild(style);
}

function buildDom() {
    if (els) {
        return;
    }
    const root = document.createElement("div");
    root.id = "zj-mobile-root";
    root.className = "zj-mobile-chrome";

    const topbar = document.createElement("div");
    topbar.className = "zj-mobile-topbar zj-mobile-chrome";
    const sessionBtn = document.createElement("button");
    sessionBtn.className = "zj-session";
    sessionBtn.addEventListener("click", () => openOverlay("sessions"));
    const paneBtn = document.createElement("button");
    paneBtn.className = "zj-pane";
    paneBtn.addEventListener("click", () => openOverlay("panes"));
    const hamburgerBtn = document.createElement("button");
    hamburgerBtn.className = "zj-hamburger";
    hamburgerBtn.textContent = "\u2630";
    hamburgerBtn.addEventListener("click", toggleMenu);
    topbar.append(sessionBtn, paneBtn, hamburgerBtn);

    const menu = buildMenu();

    const modbar = document.createElement("div");
    modbar.className = "zj-mobile-modbar zj-mobile-chrome";
    buildModifierBar(modbar);

    const panes = buildSwitcherOverlay("panes");
    const sessions = buildSwitcherOverlay("sessions");
    const newSession = buildNewSessionOverlay();

    root.append(topbar, menu, modbar, panes, sessions, newSession);
    document.body.appendChild(root);

    const returnPill = document.createElement("button");
    returnPill.id = "zj-mobile-return";
    returnPill.className = "zj-mobile-return";
    returnPill.textContent = "\u2630 Mobile UI";
    returnPill.addEventListener("click", returnToMobileUi);
    document.body.appendChild(returnPill);

    els = {
        root,
        topbar,
        sessionBtn,
        paneBtn,
        hamburgerBtn,
        menu,
        modbar,
        panes,
        sessions,
        newSession,
        returnPill,
    };
}

function buildMenu() {
    const menu = document.createElement("div");
    menu.className = "zj-mobile-menu zj-mobile-chrome";

    const renderToggle = document.createElement("button");
    renderToggle.dataset.role = "render-toggle";
    renderToggle.addEventListener("click", () => {
        state.renderMode =
            state.renderMode === "single-pane" ? "full" : "single-pane";
        if (state.renderMode === "single-pane") {
            state.fitEnabled = true;
        } else {
            state.fitEnabled = state.data.desktop_client_connected ? false : true;
        }
        closeMenu();
        sendRenderPrefs();
        render();
        reconcileSize();
    });

    const fitToggle = document.createElement("button");
    fitToggle.dataset.role = "fit-toggle";
    fitToggle.addEventListener("click", () => {
        if (!state.data.desktop_client_connected) {
            return;
        }
        state.fitEnabled = !state.fitEnabled;
        closeMenu();
        sendRenderPrefs();
        render();
        reconcileSize();
    });

    const themeToggle = document.createElement("button");
    themeToggle.dataset.role = "theme-toggle";
    themeToggle.addEventListener("click", () => {
        toggleThemePreference();
        renderMenu();
    });

    const changePane = document.createElement("button");
    changePane.textContent = "Change Pane";
    changePane.addEventListener("click", () => openOverlay("panes"));

    const changeSession = document.createElement("button");
    changeSession.textContent = "Change Session";
    changeSession.addEventListener("click", () => openOverlay("sessions"));

    const sep = document.createElement("div");
    sep.className = "zj-sep";

    const switchDesktop = document.createElement("button");
    switchDesktop.textContent = "Switch to Desktop";
    switchDesktop.addEventListener("click", switchToDesktop);

    menu.append(
        renderToggle,
        fitToggle,
        themeToggle,
        changePane,
        changeSession,
        sep,
        switchDesktop
    );
    return menu;
}

const MOD_CELLS = [
    { id: "esc", label: "ESC", kind: "key", key: "esc" },
    { id: "tab", label: "TAB", kind: "key", key: "tab" },
    { id: "ctrl", label: "CTRL", kind: "mod", mod: "ctrl" },
    { id: "alt", label: "ALT", kind: "mod", mod: "alt" },
    { id: "left", label: "\u2190", kind: "key", key: "left" },
    { id: "down", label: "\u2193", kind: "key", key: "down" },
    { id: "up", label: "\u2191", kind: "key", key: "up" },
    { id: "right", label: "\u2192", kind: "key", key: "right" },
    { id: "minus", label: "-", kind: "key", key: "minus" },
];

function buildModifierBar(modbar) {
    for (const cell of MOD_CELLS) {
        const btn = document.createElement("button");
        btn.dataset.cell = cell.id;
        btn.textContent = cell.label;
        btn.addEventListener("pointerdown", (ev) => {
            ev.preventDefault();
        });
        btn.addEventListener("click", () => handleModCell(cell));
        modbar.appendChild(btn);
    }
}

function buildSwitcherOverlay(kind) {
    const overlay = document.createElement("div");
    overlay.className = "zj-mobile-overlay zj-mobile-chrome";
    overlay.dataset.kind = kind;

    const header = document.createElement("div");
    header.className = "zj-mobile-overlay-header";
    const back = document.createElement("button");
    back.className = "zj-back";
    back.textContent = "\u2190 BACK";
    back.addEventListener("click", closeOverlay);
    const title = document.createElement("div");
    title.className = "zj-title";
    header.append(back, title);

    const label = kind === "panes" ? "Pane:" : "Session:";
    const searchRow = document.createElement("div");
    searchRow.className = "zj-mobile-search-row";
    const searchLabel = document.createElement("div");
    searchLabel.className = "zj-search-label";
    searchLabel.textContent = label;
    const search = document.createElement("input");
    search.className = "zj-search";
    search.type = "text";
    search.setAttribute("aria-label", label);
    search.addEventListener("input", () => renderCards(kind));
    searchRow.append(searchLabel, search);

    const cards = document.createElement("div");
    cards.className = "zj-mobile-cards";

    const footer = document.createElement("div");
    footer.className = "zj-mobile-footer";

    overlay.append(header, searchRow, cards, footer);
    overlay._parts = { back, title, search, cards, footer };
    return overlay;
}

function buildNewSessionOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "zj-mobile-overlay zj-mobile-chrome";
    overlay.dataset.kind = "new-session";

    const header = document.createElement("div");
    header.className = "zj-mobile-overlay-header";
    const title = document.createElement("div");
    title.className = "zj-title";
    title.textContent = "New Session";
    header.append(title);

    const nameRow = document.createElement("div");
    nameRow.className = "zj-mobile-search-row";
    const nameLabel = document.createElement("div");
    nameLabel.className = "zj-search-label";
    nameLabel.textContent = "Name:";
    const name = document.createElement("input");
    name.className = "zj-name";
    name.type = "text";
    name.setAttribute("aria-label", "Name");
    nameRow.append(nameLabel, name);

    const hint = document.createElement("div");
    hint.className = "zj-mobile-hint";
    hint.textContent = "Leave empty for a randomly generated name";

    const buttons = document.createElement("div");
    buttons.className = "zj-mobile-prompt-buttons";
    const cancel = document.createElement("button");
    cancel.className = "zj-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => openOverlay("sessions"));
    const accept = document.createElement("button");
    accept.className = "zj-accept";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => {
        navigateToSession(name.value.trim());
    });
    buttons.append(cancel, accept);

    overlay.append(header, nameRow, hint, buttons);
    overlay._parts = { name };
    return overlay;
}

function toggleMenu() {
    els.menu.classList.toggle("zj-open");
    renderMenu();
}

function closeMenu() {
    els.menu.classList.remove("zj-open");
}

// Capture phase: the terminal and its xterm handlers stop propagation of pointer events,
// so a bubbling listener would never see taps landing on a pane.
function installMenuDismissHook() {
    document.addEventListener(
        "pointerdown",
        (ev) => {
            if (!els || !els.menu.classList.contains("zj-open")) {
                return;
            }
            const target = ev.target;
            if (!(target instanceof Node)) {
                closeMenu();
                return;
            }
            if (els.menu.contains(target) || els.hamburgerBtn.contains(target)) {
                return;
            }
            closeMenu();
        },
        true
    );
}

function openOverlay(kind) {
    closeMenu();
    state.activeOverlay = kind;
    render();
    if (kind === "panes" || kind === "sessions") {
        startActivityTimer();
    } else {
        stopActivityTimer();
    }
    if (kind === "sessions") {
        if (standalone) {
            refreshStandaloneSessions();
        } else {
            requestSessionList();
        }
    }
}

function sendControl(payload) {
    if (window.__zjSendControl) {
        window.__zjSendControl(payload);
    }
}

function requestSessionList() {
    sendControl({ type: "RequestSessionList" });
}

function sendRenderPrefs() {
    sendControl({
        type: "SetMobileRenderPreferences",
        single_pane: state.renderMode === "single-pane",
        fit: state.fitEnabled,
    });
}

function closeOverlay() {
    state.activeOverlay = "none";
    stopActivityTimer();
    render();
}

function switchToDesktop() {
    closeMenu();
    state.activeOverlay = "none";
    sendControl({
        type: "SetMobileRenderPreferences",
        single_pane: false,
        fit: true,
    });
    setActivationPreference("off");
    state.active = false;
    state.initialPrefsSent = false;
    state.renderMode = "full";
    document.body.classList.remove("zj-mobile-active");
    render();
    reconcileSize();
}

function returnToMobileUi() {
    setActivationPreference("on");
    evaluateActivation();
}

function handleModCell(cell) {
    if (cell.kind === "mod") {
        state.armed[cell.mod] = !state.armed[cell.mod];
        renderModifierBar();
        return;
    }
    const bytes = serializeKey(cell.key, state.armed);
    state.armed.ctrl = false;
    state.armed.alt = false;
    renderModifierBar();
    const send = ctx.getSendAnsiKey();
    if (send) {
        send(bytes);
    }
}

function modifierParam(armed, shift) {
    let m = 1;
    if (shift) m += 1;
    if (armed.alt) m += 2;
    if (armed.ctrl) m += 4;
    return m;
}

function ctrlByte(ch) {
    const c = ch.charCodeAt(0);
    if (ch === "@" || ch === " ") return "\x00";
    if (ch >= "a" && ch <= "z") return String.fromCharCode(c - 0x60);
    if (ch >= "A" && ch <= "Z") return String.fromCharCode(c - 0x40);
    if (ch === "[") return "\x1b";
    if (ch === "\\") return "\x1c";
    if (ch === "]") return "\x1d";
    if (ch === "^") return "\x1e";
    if (ch === "_" || ch === "?") return "\x1f";
    return ch;
}

function serializeKey(key, armed) {
    const modified = armed.ctrl || armed.alt;
    const arrowLetter = { left: "D", down: "B", up: "A", right: "C" };
    if (key in arrowLetter) {
        const letter = arrowLetter[key];
        if (modified) {
            return `\x1b[1;${modifierParam(armed, false)}${letter}`;
        }
        return `\x1b[${letter}`;
    }
    if (key === "esc") {
        return armed.alt ? "\x1b\x1b" : "\x1b";
    }
    if (key === "tab") {
        return armed.alt ? "\x1b\t" : "\t";
    }
    if (key === "minus") {
        return mergeChar("-", armed);
    }
    return "";
}

function mergeChar(ch, armed) {
    let body = ch;
    if (armed.ctrl) {
        body = ctrlByte(ch);
    }
    if (armed.alt) {
        body = "\x1b" + body;
    }
    return body;
}

function installKeyMergeHook() {
    window.__zjMobileMergeKey = (payload) => {
        if (!state.active) {
            return payload;
        }
        if (!state.armed.ctrl && !state.armed.alt) {
            return payload;
        }
        if (typeof payload !== "string" || payload.length !== 1) {
            return payload;
        }
        const code = payload.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
            return payload;
        }
        const merged = mergeChar(payload, state.armed);
        state.armed.ctrl = false;
        state.armed.alt = false;
        renderModifierBar();
        return merged;
    };
}

function installSoftKeyboardBinding() {
    window.addEventListener("zellij:soft-keyboard-visibility", (ev) => {
        state.kbdVisible = !!(ev.detail && ev.detail.visible);
        renderModifierBar();
        updateKeyboardOffset();
        reconcileSize();
    });
}

let resizeHooksInstalled = false;

function installResizeReconcileHooks() {
    if (resizeHooksInstalled) {
        return;
    }
    resizeHooksInstalled = true;
    const onViewportChange = () => {
        updateStandaloneViewportVars();
        updateKeyboardOffset();
        reconcileSize();
    };
    window.addEventListener("resize", onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", onViewportChange);
        window.visualViewport.addEventListener("scroll", onViewportChange);
    }
}

// The standalone menu runs before the websocket resize handler exists, so nothing else keeps
// `--dynamic-vh` in step with the visible viewport (URL bar, soft keyboard) while it is up.
function updateStandaloneViewportVars() {
    if (!state.standalone) {
        return;
    }
    const root = document.documentElement;
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const width = vv ? vv.width : window.innerWidth;
    root.style.setProperty("--dynamic-vh", `${height}px`);
    root.style.setProperty("--dynamic-vw", `${width}px`);
}

function updateKeyboardOffset() {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!state.active || !vv) {
        root.style.setProperty("--zj-kbd-offset", "0px");
        return;
    }
    const occluded = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop
    );
    root.style.setProperty("--zj-kbd-offset", `${occluded}px`);
}

function getRenderSizing() {
    if (!state.active || state.fitEnabled) {
        return { pinned: false };
    }
    const size = state.data.desktop_size;
    if (
        !state.data.desktop_client_connected ||
        !size ||
        !size.cols ||
        !size.rows
    ) {
        return { pinned: false };
    }
    return { pinned: true, cols: size.cols, rows: size.rows };
}

function syncPan() {
    if (!window.__zjMobilePan) {
        return;
    }
    window.__zjMobilePan.setActive(getRenderSizing().pinned);
}

function reconcileSize() {
    const root = document.documentElement;
    if (!state.active) {
        root.style.setProperty("--zj-chrome-top", "0px");
        root.style.setProperty("--zj-chrome-bottom", "0px");
        window.dispatchEvent(new Event("zellij:rendering-resize"));
        requestAnimationFrame(syncPan);
        return;
    }
    const topVisible = els.topbar.style.display !== "none";
    const topH = topVisible ? els.topbar.offsetHeight : 0;
    const modVisible = els.modbar.classList.contains("zj-visible");
    const modH = modVisible ? els.modbar.offsetHeight : 0;
    root.style.setProperty("--zj-chrome-top", `${topH}px`);
    root.style.setProperty("--zj-chrome-bottom", `${modH}px`);
    window.dispatchEvent(new Event("zellij:rendering-resize"));
    requestAnimationFrame(syncPan);
}

function render() {
    if (!els) {
        return;
    }
    // The topbar hosts the only entry point to the menu, so it stays visible in every render
    // mode - hiding it in full render leaves the user with no way back.
    els.topbar.style.display = "flex";

    els.sessionBtn.textContent = state.data.session_name || "session";
    els.paneBtn.textContent = activePaneLabel();

    renderMenu();
    renderModifierBar();
    renderOverlays();
    renderReturnPill();
}

function renderReturnPill() {
    if (!els || !els.returnPill) {
        return;
    }
    const visible = activationPreference() === "off" && isMobileViewport();
    els.returnPill.style.display = visible ? "block" : "none";
}

function activePaneLabel() {
    const active = state.data.active_pane;
    if (!active) {
        return "\u2014";
    }
    const pane = state.data.panes.find(
        (p) => p.pane_id === active.pane_id && p.is_plugin === active.is_plugin
    );
    if (pane && pane.title) {
        return pane.title;
    }
    return active.pane_id != null ? `#${active.pane_id}` : "\u2014";
}

function checkbox(on) {
    return on ? "[x]" : "[ ]";
}

function renderMenu() {
    if (!els.menu.classList.contains("zj-open")) {
        return;
    }
    const renderToggle = els.menu.querySelector('[data-role="render-toggle"]');
    renderToggle.textContent = `${checkbox(
        state.renderMode === "single-pane"
    )} Single pane`;

    const fitToggle = els.menu.querySelector('[data-role="fit-toggle"]');
    const canFit = state.data.desktop_client_connected;
    fitToggle.textContent = `${checkbox(state.fitEnabled)} Fit to my screen`;
    fitToggle.classList.toggle("zj-disabled", !canFit);

    const themeToggle = els.menu.querySelector('[data-role="theme-toggle"]');
    themeToggle.textContent = `${checkbox(
        effectiveTheme() === "light"
    )} Light mode`;
}

function renderModifierBar() {
    const visible = state.active && state.kbdVisible;
    els.modbar.classList.toggle("zj-visible", visible);
    for (const cell of MOD_CELLS) {
        const btn = els.modbar.querySelector(`[data-cell="${cell.id}"]`);
        if (!btn) continue;
        if (cell.kind === "mod") {
            btn.classList.toggle("zj-armed", state.armed[cell.mod]);
        }
    }
}

function renderOverlays() {
    for (const kind of ["panes", "sessions", "new-session"]) {
        const overlay = els[camel(kind)];
        overlay.classList.toggle("zj-open", state.activeOverlay === kind);
    }
    if (state.activeOverlay === "panes") {
        setupPanesFooter();
        renderCards("panes");
        els.panes._parts.title.textContent = "Switch Pane";
    } else if (state.activeOverlay === "sessions") {
        setupSessionsFooter();
        renderSessionsHeader();
        renderCards("sessions");
    }
}

function camel(kind) {
    return kind === "new-session" ? "newSession" : kind;
}

function renderSessionsHeader() {
    const parts = els.sessions._parts;
    const welcome = state.data.is_welcome_screen;
    parts.title.textContent = welcome ? "Hi from Zellij!" : "Switch Session";
    parts.back.style.display = welcome ? "none" : "";
}

function setupPanesFooter() {
    const footer = els.panes._parts.footer;
    footer.innerHTML = "";
    const newTab = document.createElement("button");
    newTab.textContent = "+ New Tab";
    newTab.addEventListener("click", () => {
        sendControl({ type: "NewTab" });
        closeOverlay();
    });
    footer.append(newTab);
    const active = state.data.active_pane;
    if (active && active.tab_position != null) {
        const newPane = document.createElement("button");
        newPane.textContent = "+ New Pane";
        newPane.addEventListener("click", () => {
            sendControl({
                type: "NewPaneInTab",
                tab_id: active.tab_position,
            });
            closeOverlay();
        });
        footer.append(newPane);
    }
}

function setupSessionsFooter() {
    const footer = els.sessions._parts.footer;
    footer.innerHTML = "";
    const newSession = document.createElement("button");
    newSession.textContent = "+ New Session";
    newSession.addEventListener("click", () => openOverlay("new-session"));
    footer.append(newSession);
}

function renderCards(kind) {
    const overlay = els[camel(kind)];
    const parts = overlay._parts;
    const query = parts.search.value || "";
    parts.cards.innerHTML = "";
    const items =
        kind === "panes" ? paneCardData() : sessionCardData();
    const matched = filterAndSort(items, query, (it) => it.searchText);
    for (const { item, indices } of matched) {
        parts.cards.appendChild(renderCard(kind, item, indices));
    }
    if (!matched.length) {
        const empty = document.createElement("div");
        empty.className = "zj-mobile-empty";
        empty.textContent = query
            ? "No matches"
            : kind === "sessions"
              ? "No other sessions"
              : "No panes";
        parts.cards.appendChild(empty);
    }
}

function paneCardData() {
    const tabsByPos = {};
    for (const t of state.data.tabs) {
        tabsByPos[t.position] = t.name;
    }
    const active = state.data.active_pane;
    const now = nowSecs();
    return state.data.panes.map((p) => {
        const title = p.title || `#${p.pane_id}`;
        const isCurrent =
            active &&
            active.pane_id === p.pane_id &&
            active.is_plugin === p.is_plugin;
        const tabName = tabsByPos[p.tab_position] || "";
        const activity = isCurrent
            ? "[CURRENT PANE]"
            : `Active ${formatActivity(p.last_activity_secs_ago, now)}`;
        return {
            searchText: title,
            title,
            meta: `${tabName}, ${activity}`,
            pane_id: p.pane_id,
            is_plugin: p.is_plugin,
        };
    });
}

function sessionCardData() {
    const current = state.data.session_name;
    const now = nowSecs();
    const base = state.data.now_secs || now;
    return state.data.sessions
        .filter(
            (s) => s.name !== current && s.web_clients_allowed !== false
        )
        .map((s) => {
            const createdSecsAgo =
                s.creation_secs_ago != null
                    ? s.creation_secs_ago + (now - base)
                    : null;
            const counts = `${s.tab_count} tabs, ${s.pane_count} panes, ${s.connected_clients} client(s)`;
            const created =
                createdSecsAgo != null
                    ? `Created ${formatActivity(createdSecsAgo, now)}`
                    : "";
            return {
                searchText: s.name,
                title: s.name,
                meta: created ? `${counts} · ${created}` : counts,
                name: s.name,
            };
        });
}

function renderCard(kind, item, indices) {
    const card = document.createElement("div");
    card.className = "zj-mobile-card";
    const title = document.createElement("div");
    title.className = "zj-card-title";
    title.append(highlight(item.title, indices));
    const meta = document.createElement("div");
    meta.className = "zj-card-meta";
    meta.textContent = item.meta;
    card.append(title, meta);
    card.addEventListener("click", () => {
        if (kind === "sessions") {
            navigateToSession(item.name);
        } else {
            sendControl({
                type: "FocusPane",
                pane_id: item.pane_id,
                is_plugin: item.is_plugin,
            });
            closeOverlay();
        }
    });
    return card;
}

function highlight(text, indices) {
    const frag = document.createDocumentFragment();
    const set = new Set(indices || []);
    let run = "";
    let runMatch = false;
    const flush = () => {
        if (!run) return;
        if (runMatch) {
            const span = document.createElement("span");
            span.className = "zj-match";
            span.textContent = run;
            frag.append(span);
        } else {
            frag.append(document.createTextNode(run));
        }
        run = "";
    };
    for (let i = 0; i < text.length; i++) {
        const m = set.has(i);
        if (m !== runMatch && run) {
            flush();
        }
        runMatch = m;
        run += text[i];
    }
    flush();
    return frag;
}

function filterAndSort(items, query, keyOf) {
    if (!query) {
        return items
            .slice()
            .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
            .map((item) => ({ item, indices: [] }));
    }
    const scored = [];
    for (const item of items) {
        const res = fuzzyScore(keyOf(item), query);
        if (res) {
            scored.push({ item, score: res.score, indices: res.indices });
        }
    }
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return keyOf(a.item).localeCompare(keyOf(b.item));
    });
    return scored;
}

function fuzzyScore(text, query) {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let score = 0;
    let ti = 0;
    let prevMatch = -2;
    const indices = [];
    for (let qi = 0; qi < lowerQuery.length; qi++) {
        const qc = lowerQuery[qi];
        let found = -1;
        for (let i = ti; i < lowerText.length; i++) {
            if (lowerText[i] === qc) {
                found = i;
                break;
            }
        }
        if (found === -1) {
            return null;
        }
        indices.push(found);
        score += 16;
        if (found === prevMatch + 1) {
            score += 8;
        }
        if (found === 0 || /\W/.test(lowerText[found - 1])) {
            score += 4;
        }
        score -= found - ti;
        prevMatch = found;
        ti = found + 1;
    }
    return { score, indices };
}

function formatActivity(secsAgo, now) {
    if (secsAgo == null) {
        return "\u2014";
    }
    const diff = secsAgo;
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function startActivityTimer() {
    stopActivityTimer();
    activityTimer = setInterval(() => {
        if (
            state.activeOverlay === "panes" ||
            state.activeOverlay === "sessions"
        ) {
            renderCards(state.activeOverlay);
        }
    }, 1000);
}

function stopActivityTimer() {
    if (activityTimer) {
        clearInterval(activityTimer);
        activityTimer = null;
    }
}

function navigateToSession(name) {
    // Navigating the standalone menu to the base URL would land back on the menu, so the
    // unnamed case hands control back to the caller to boot a session in place instead.
    if (standalone && !name) {
        finishStandalone({ createUnnamedSession: true });
        return;
    }
    const baseUrl = getBaseUrl();
    if (name) {
        window.location.href = `${baseUrl}/${encodeURIComponent(name)}`;
    } else {
        window.location.href = baseUrl;
    }
}

function emptyMobileState() {
    return {
        session_name: "",
        now_secs: Math.floor(Date.now() / 1000),
        is_welcome_screen: false,
        desktop_client_connected: false,
        desktop_size: null,
        active_pane: null,
        tabs: [],
        panes: [],
        sessions: [],
        render_prefs: {
            single_pane: false,
            fit: true,
            active_pane_is_fullscreen: false,
        },
    };
}
// One ordered stream for input and controls. Only this browser and the retained
// attachment own delivery state; replaceable relay/web services own none of it.
const QUEUE_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 48 * 1024;

class LogicalSocket extends EventTarget {
    constructor(owner, channel) {
        super(); this.owner = owner; this.channel = channel;
        this.readyState = 0; this.resumable = true;
        this.onopen = this.onmessage = this.onclose = null;
    }
    fire(type, data = {}) {
        const event = type === 'message' ? new MessageEvent(type, data) : new Event(type);
        if (data.code !== undefined) Object.defineProperty(event, 'code', { value: data.code });
        this.dispatchEvent(event); this['on' + type]?.(event);
    }
    send(data) {
        if (this.readyState !== 1) throw new Error('Terminal attachment is not open');
        if (this.channel === 'control') {
            const message = JSON.parse(data);
            if (message.web_client_id !== this.owner.viewer) throw new Error('Wrong terminal attachment');
            data = JSON.stringify(message.payload);
        }
        this.owner.enqueue(this.channel, String(data));
    }
    close() { this.owner.close(); }
}

function resumableSockets(base, boot, dimensions) {
    const owner = new ResumableConnection(base, boot, dimensions);
    window.__zjSuspendTerminal = canRetire => owner.retire(canRetire);
    // The sidebar observes the same raw terminal/control events as before.
    // It must not parse the private delivery envelopes from the real socket.
    window.dispatchEvent(new CustomEvent('zellij-resumable-sockets', { detail: {
        terminal: owner.terminal, control: owner.control,
    }}));
    queueMicrotask(() => owner.connect());
    return owner;
}

class ResumableConnection {
    constructor(base, boot, dimensions = {}) {
        this.base = base; this.viewer = boot.web_client_id;
        this.session = boot.resumable.session; this.dimensions = dimensions;
        this.generation = 0; this.applied = 0; this.inputAck = 0; this.nextInput = 1;
        this.pending = []; this.bytes = 0; this.inflight = null; this.socket = null;
        this.nonce = null; this.stopped = false; this.first = true; this.retry = null;
        this.offlineSince = null; this.outputWork = Promise.resolve();
        this.replacementAck = null;
        this.terminal = new LogicalSocket(this, 'terminal');
        this.control = new LogicalSocket(this, 'control');
    }
    enqueue(channel, data) {
        if (this.stopped || this.retiring) throw new Error('Terminal attachment has ended or is retiring');
        const size = new TextEncoder().encode(data).length;
        if (this.bytes + size > QUEUE_LIMIT) {
            this.fail('Pending terminal input reached its limit. This input was not sent; the earlier queue was retained.');
            return;
        }
        if (channel === 'control' && size > FRAME_LIMIT) {
            this.fail('Terminal control message exceeds the delivery limit.'); return;
        }
        // Split by code points, never UTF-16 surrogate halves. The retained
        // parser already handles escape and paste sequences across records.
        let part = '', length = 0;
        const append = text => {
            const bytes = new TextEncoder().encode(text).length;
            const tail = this.pending.at(-1);
            // Keys typed while a record awaits its ack leave together, one round trip for all
            // of them. A record already sent stays byte-identical for its resend.
            if (channel === 'terminal' && tail?.channel === channel && !tail.sent && tail.bytes + bytes <= FRAME_LIMIT) {
                tail.data += text; tail.bytes += bytes;
            } else this.pending.push({ seq: this.nextInput++, channel, data: text, bytes });
            this.bytes += bytes;
        };
        for (const character of data) {
            const bytes = new TextEncoder().encode(character).length;
            if (length + bytes > FRAME_LIMIT) { append(part); part = ''; length = 0; }
            part += character; length += bytes;
        }
        if (part) append(part);
        this.flush();
    }
    flush() {
        if (this.stopped || !this.connected || !this.pending.length || this.inflight !== null) return;
        const { bytes, sent, ...input } = this.pending[0];
        this.pending[0].sent = true; this.inflight = input.seq;
        this.socket.send(JSON.stringify({ type: 'input', generation: this.generation, input }));
    }
    acknowledge(sequence, replaceable = false) {
        if (!Number.isSafeInteger(sequence) || sequence < this.inputAck || sequence >= this.nextInput || sequence > (this.pending[0]?.seq ?? this.inputAck)) {
            throw new Error('Invalid terminal input acknowledgment');
        }
        while (this.pending[0]?.seq <= sequence) this.bytes -= this.pending.shift().bytes;
        this.inputAck = sequence; this.replacementAck = replaceable === true ? sequence : null;
        this.inflight = null; this.flush();
    }
    connect() {
        if (this.stopped || this.retirementPaused) return;
        this.nonce ||= crypto.randomUUID();
        const query = new URLSearchParams({ session: this.session, web_client_id: this.viewer,
            generation: this.generation, nonce: this.nonce, applied: this.applied, ...this.dimensions });
        // Only a new attachment reads this; a retained one keeps its reported state.
        if (window.__zjViewerHidden?.()) query.set('hidden', 'true');
        const socket = this.socket = new WebSocket(`${this.base}/ws/resume?${query}`);
        this.connected = false;
        this.lastReceived = Date.now();
        clearInterval(this.watchdog);
        this.watchdog = setInterval(() => {
            if (this.stopped || this.socket !== socket) return;
            if (Date.now() - this.lastReceived > 10000) {
                // Do not wait for the TCP close handshake on a blackholed link.
                socket.onclose(); socket.close();
            }
            if (this.retiring && this.offlineSince !== null && Date.now() - this.offlineSince >= 120000) this.pauseRetirement();
        }, 1000);
        socket.onmessage = event => {
            if (this.socket !== socket || this.stopped) return;
            this.lastReceived = Date.now();
            let message;
            try { message = JSON.parse(event.data); } catch (_) { this.fail('Invalid terminal delivery response'); return; }
            try {
                if (message.type === 'hello') {
                    if (!Number.isSafeInteger(message.generation) || message.generation < this.generation || message.generation > this.generation + 1) throw new Error('Invalid terminal generation');
                    this.generation = message.generation; this.nonce = null;
                    this.connected = true; this.offlineSince = null;
                    this.acknowledge(message.input_ack, message.replaceable);
                    if (this.first) {
                        this.first = false;
                        this.terminal.readyState = this.control.readyState = 1;
                        this.terminal.fire('open'); this.control.fire('open');
                    }
                    markConnectionEstablished(); this.flush();
                    this.checkRetirement?.();
                } else if (message.type === 'heartbeat') {
                    this.replacementAck = message.replaceable === true && message.input_ack === this.inputAck ? this.inputAck : null;
                    socket.send(JSON.stringify({type:'ack',generation:this.generation,applied:this.applied}));
                } else if (message.type === 'ack') this.acknowledge(message.input_ack, message.replaceable);
                else if (message.type === 'retirement_rejected') {
                    if (!this.retirement) throw new Error('Unexpected retirement response');
                    const {reject} = this.retirement; this.clearRetirement(); this.retiring = false;
                    reject(new Error(message.message));
                } else if (message.type === 'retired') {
                    if (!this.retirement) throw new Error('Terminal attachment was retired');
                    const {resolve} = this.retirement; this.clearRetirement();
                    this.connected = false; this.close(); resolve(true);
                } else if (message.type === 'expired' || (message.type === 'error' && message.failure?.code === 'attachment_expired')) {
                    // An empty browser queue alone is insufficient: an acknowledged
                    // paste prefix can still be buffered in the worker's parser.
                    if (!this.pending.length && (this.nextInput === 1 || this.replacementAck === this.inputAck) && !this.retirement && !this.retiring) {
                        this.connected = false;
                        this.close(1006); // the existing bootstrap restores the same pane
                    } else this.fail(message.message || ('The terminal connection expired before safe recovery could be confirmed.' +
                        (this.pending.length ? ' Unsent input is kept in this page.' : '')), message.failure, message.failure_saved);
                } else if (message.type === 'error') this.fail(message.message, message.failure, message.failure_saved);
                else if (message.type === 'output') {
                    this.outputWork = this.outputWork.then(() => this.apply(message.record)).catch(error => this.fail(error.message));
                } else throw new Error('Unknown terminal delivery response');
            } catch (error) { this.fail(error.message); }
        };
        socket.onclose = () => {
            if (this.socket !== socket || this.stopped) return;
            this.socket = null; this.connected = false; this.inflight = null;
            this.offlineSince ??= Date.now();
            const elapsed = Date.now() - this.offlineSince;
            if (elapsed > 1500) showConnectionStatus("Reconnecting… Typing is buffered");
            if (this.retiring && elapsed >= 120000) {
                this.pauseRetirement(); return;
            }
            // Time offline, including browser suspension, says nothing about
            // whether the worker can resume. Keep the same owner and input
            // journal until it replies; never replace them on a timer.
            this.retry = setTimeout(() => this.connect(), Math.min(1000, 100 + elapsed / 10));
        };
        socket.onerror = () => {}; // close drives the retry
    }
    async apply(record) {
        if (this.stopped) return;
        // A resync record follows terminal output the server dropped for a
        // viewer that fell too far behind; the engine repaints the screen.
        if (!Number.isSafeInteger(record.seq) || record.seq < 1 || (record.seq > this.applied + 1 && record.resync !== true)) throw new Error('Terminal output sequence gap');
        if (record.seq <= this.applied) return;
        if (record.channel === 'terminal') {
            // websockets.js supplies this callback after cursor/title filtering.
            // Acknowledging on receipt could lose an in-flight xterm write.
            await new Promise((resolve, reject) => {
                if (!this.terminal.onmessage) { reject(new Error('Terminal renderer unavailable')); return; }
                const event = new MessageEvent('message', { data: record.data });
                Object.defineProperty(event, 'applied', { value: resolve });
                this.terminal.dispatchEvent(event); this.terminal.onmessage(event);
            });
        } else if (record.channel === 'control') this.control.fire('message', { data: record.data });
        else throw new Error('Unknown terminal output channel');
        this.applied = record.seq;
        if (this.connected) this.socket.send(JSON.stringify({ type: 'ack', generation: this.generation, applied: this.applied }));
    }
    clearRetirement() {
        clearInterval(this.retirementTimer); this.retirement = null; this.checkRetirement = null;
    }
    pauseRetirement() {
        // A lost refusal can hide parser-buffered input. Preserve this owner;
        // only an authenticated retirement receipt permits replacement.
        this.retirementPaused = true;
        clearTimeout(this.retry); clearInterval(this.watchdog);
        const socket = this.socket; this.socket = null; this.connected = false; socket?.close();
        if (this.retirement) {
            const {reject} = this.retirement; this.clearRetirement();
            const error = new Error('Terminal disconnect is unconfirmed. Retry to recover this viewer before typing.');
            error.unresolvedRetirement = true; reject(error);
        }
    }
    retire(canRetire = () => true) {
        if (this.retirement) return this.retirement.promise;
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        this.retirement = {promise, resolve, reject};
        if (this.retirementPaused) {
            this.retirementPaused = false; this.offlineSince = null; this.connect();
        }
        const deadline = Date.now() + 120000;
        let sentSocket = null;
        this.checkRetirement = () => {
            if (!this.retiring && !canRetire()) { this.clearRetirement(); resolve(false); return; }
            if (this.stopped || Date.now() >= deadline) {
                if (this.retiring && !this.stopped) { this.pauseRetirement(); return; }
                this.clearRetirement(); const error = new Error('Terminal input or retirement could not be confirmed. Return to Terminal; pending input is kept.');
                error.unresolvedRetirement = !!this.retiring; error.retryableRetirement = false; reject(error); return;
            }
            if (this.pending.length || !this.connected || sentSocket === this.socket) return;
            this.retiring = true; sentSocket = this.socket;
            this.socket.send(JSON.stringify({type:'retire',generation:this.generation}));
        };
        this.retirementTimer = setInterval(() => this.checkRetirement?.(), 50);
        this.checkRetirement();
        return promise;
    }
    fail(message, failure, saved = false) {
        if (this.stopped) return;
        if (this.retirement) {
            const {reject} = this.retirement; this.clearRetirement();
            const error = new Error(message); error.unresolvedRetirement = !!this.retiring; error.retryableRetirement = false; reject(error);
        }
        // Keep the actual input queue available for explicit recovery; never
        // attach it to a different viewer, pane or newly-created session.
        window.__zjPendingTerminalInput = this.pending.map(({ channel, data }) => ({ channel, data }));
        window.__zjResumeFailure = String(message);
        window.__zjTerminalFailure = failure;
        window.__zjTerminalFailureSaved = saved === true;
        window.__zjPendingTerminalRecords = this.pending.length;
        this.close();
        showConnectionStatus();
        window.dispatchEvent(new CustomEvent('zellij-resume-failed', { detail: String(message) }));
    }
    close(code = 4001) {
        if (this.stopped) return;
        if (this.connected && !this.retiring) {
            try { this.socket.send(JSON.stringify({ type: 'close', generation: this.generation })); } catch (_) {}
        }
        this.stopped = true; this.connected = false; clearTimeout(this.retry); clearInterval(this.watchdog);
        this.socket?.close();
        for (const socket of [this.terminal, this.control]) {
            socket.readyState = 3; socket.fire('close', { code });
        }
    }
}

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

function initWebSockets(boot, term, fitAddon) {
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

function setupResizeHandler(
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

document.addEventListener("DOMContentLoaded", async (event) => {
    initConnectionHandlers();

    const sessionFromPath = location.pathname.split("/").pop();

    // A session name in the path is an explicit request for that session; only the bare root,
    // which would otherwise boot a welcome session, is replaced by the session menu.
    let welcome = true;
    if (!sessionFromPath && shouldUseStandaloneMenu()) {
        document.title = "Zellij";
        await showStandaloneSessionMenu({ fetchSessions: fetchSessionList });
        welcome = false;
    }

    let boot;
    try { boot = await fetchSession(sessionFromPath, { welcome }); }
    catch (error) { await handleDisconnected(error.message); return; }

    if (!location.pathname.endsWith(`/${boot.session_name}`)) {
        history.replaceState(null, "", boot.session_name);
    }

    const { term, fitAddon } = initTerminal(boot.config);
    settleFontSize(term, fitAddon, boot.config);

    let websockets = null;
    initMobileUi({
        term,
        fitAddon,
        getSendAnsiKey: () => (websockets ? websockets.sendAnsiKey : () => {}),
    });

    document.title = boot.session_name;
    websockets = initWebSockets(boot, term, fitAddon);

    setupInputHandlers(term, fitAddon, websockets.sendAnsiKey);
});
