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

export function getReconnectionDelay(attempt) {
    if (attempt <= QUICK_ATTEMPTS) return 0.25;
    const delays = [1, 2, 4, 8, 16];
    return delays[Math.min(attempt - QUICK_ATTEMPTS - 1, delays.length - 1)];
}

export function setReconnectHandler(handler) {
    reconnectHandler = handler;
}

export function showConnectionStatus(message = "Reconnecting… Input paused") {
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

export async function handleDisconnected(reason = "You have been disconnected by the host.") {
    if (isDisconnected || isPageUnloading) return;
    isDisconnected = true;
    isReconnecting = false;
    clearConnectionStatus();
    await showErrorModal("Disconnected", reason);
}

export async function handleReconnection() {
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

export function initConnectionHandlers() {
    const unload = () => { isPageUnloading = true; clearConnectionStatus(); };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", unload);
}

export function markConnectionEstablished() {
    connectedAt = Date.now();
    clearConnectionStatus();
}

export function resetConnectionState() {
    reconnectionAttempt = 0;
    isReconnecting = false;
    isDisconnected = false;
    isPageUnloading = false;
    connectedAt = 0;
    clearConnectionStatus();
}
