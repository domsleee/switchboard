/**
 * Connection-related utility functions and management
 */

import { getBaseUrl } from "./utils.js";

// Connection state
let reconnectionAttempt = 0;
let isReconnecting = false;
let isDisconnected = false;
let reconnectionTimeout = null;
let hasConnectedBefore = false;
let isPageUnloading = false;

// An upgrade restarts the web server and relay for about a second, so retry
// every 250 ms for the first 10 seconds before backing off.
const QUICK_ATTEMPTS = 40;

/**
 * Get the delay for reconnection attempts: quick retries, then exponential backoff
 * @param {number} attempt - The current attempt number (1-based)
 * @returns {number} The delay in seconds
 */
export function getReconnectionDelay(attempt) {
    if (attempt <= QUICK_ATTEMPTS) {
        return 0.25;
    }
    const delays = [1, 2, 4, 8, 16];
    return delays[Math.min(attempt - QUICK_ATTEMPTS - 1, delays.length - 1)];
}

// A page that reloaded itself and soon lost its connection again (the session
// refuses web clients, for example) resumes the backoff instead of reloading
// every 250 ms.
const RELOAD_KEY = "zellij-reconnect-reload";

function resumedAttempts() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(RELOAD_KEY));
        return Date.now() - saved.at < 30000 ? Math.max(saved.attempt, QUICK_ATTEMPTS) : 0;
    } catch (_) {
        return 0;
    }
}

/**
 * Check if the server connection is available
 * @returns {Promise<boolean>} true if connection is OK, false otherwise
 */
export async function checkConnection() {
    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/info/version`, {
            method: "GET",
            signal: AbortSignal.timeout?.(5000),
        });
        return response.ok;
    } catch (error) {
        return false;
    }
}

/**
 * Handle intentional disconnection by the host (close code 4001)
 * @returns {Promise<void>}
 */
export async function handleDisconnected() {
    if (isDisconnected || isPageUnloading) {
        return;
    }
    isDisconnected = true;
    await showErrorModal("Disconnected", "You have been disconnected by the host.");
    isDisconnected = false;
}

/**
 * Handle reconnection attempts with exponential backoff
 * @returns {Promise<void>}
 */
export async function handleReconnection() {
    if (isReconnecting || !hasConnectedBefore || isPageUnloading) {
        return;
    }

    isReconnecting = true;
    reconnectionAttempt = resumedAttempts();
    let currentModal = null;

    while (isReconnecting) {
        reconnectionAttempt++;
        const delaySeconds = getReconnectionDelay(reconnectionAttempt);

        const result = await showReconnectionModal(
            reconnectionAttempt,
            delaySeconds
        );

        if (result.action === "cancel") {
            if (result.cleanup) result.cleanup();
            isReconnecting = false;
            reconnectionAttempt = 0;
            return;
        }

        if (result.action === "reconnect") {
            currentModal = result.modal;
            const connectionOk = await checkConnection();

            if (connectionOk) {
                if (result.cleanup) result.cleanup();
                isReconnecting = false;
                try {
                    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ at: Date.now(), attempt: reconnectionAttempt }));
                } catch (_) {}
                reconnectionAttempt = 0;
                window.location.reload();
                return;
            } else {
                if (result.cleanup) result.cleanup();
                continue;
            }
        }
    }
}

/**
 * Initialize connection handlers and event listeners
 */
export function initConnectionHandlers() {
    window.addEventListener("beforeunload", () => {
        isPageUnloading = true;
    });

    window.addEventListener("pagehide", () => {
        isPageUnloading = true;
    });
}

/**
 * Mark that a connection has been established
 */
export function markConnectionEstablished() {
    hasConnectedBefore = true;
}

/**
 * Reset connection state
 */
export function resetConnectionState() {
    reconnectionAttempt = 0;
    isReconnecting = false;
    isDisconnected = false;
    reconnectionTimeout = null;
    hasConnectedBefore = false;
    isPageUnloading = false;
}
