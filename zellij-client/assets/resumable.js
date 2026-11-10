// One ordered stream for input and controls. Only this browser and the retained
// attachment own delivery state; replaceable relay/web services own none of it.
import { markConnectionEstablished, showConnectionStatus } from './connection.js';
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

export function resumableSockets(base, boot, dimensions) {
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

export class ResumableConnection {
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
