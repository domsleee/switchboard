/**
 * Keyboard handling functions
 */

/**
 * Encode a keyboard event into kitty protocol ANSI escape sequence
 * @param {KeyboardEvent} ev - The keyboard event to encode
 * @param {function} send_ansi_key - Function to send the ANSI key sequence
 */
export function encode_kitty_key(ev, send_ansi_key) {
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
