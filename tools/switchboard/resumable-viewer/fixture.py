"""Raw-mode fixture; record application-observed input, emit numbered output."""
import os, sys, threading, time, json
root = sys.argv[1]
if os.name == 'nt':
    import ctypes, msvcrt
    kernel = ctypes.windll.kernel32
    mode = ctypes.c_ulong()
    handle = kernel.GetStdHandle(-10)
    kernel.GetConsoleMode(handle, ctypes.byref(mode))
    kernel.SetConsoleMode(handle, (mode.value & ~7) | 0x200)
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
else:
    import tty
    tty.setraw(sys.stdin.fileno())
os.write(sys.stdout.fileno(), b'\x1b[?2004h')  # Fixture accepts bracketed paste bytes.
with open(os.path.join(root, 'fixture.json'), 'w') as f:
    json.dump({'pid': os.getpid()}, f)
def output():
    while not os.path.exists(os.path.join(root, 'go')): time.sleep(.01)
    with open(os.path.join(root, 'output.txt'), 'w', buffering=1) as f, open(os.path.join(root, 'output-times.jsonl'), 'w', buffering=1) as times:
        for i in range(1, 401):
            line = 'OUT:%06d' % i
            if os.path.exists(os.path.join(root, 'stop')): break
            times.write(json.dumps({'line': line, 'time':time.time()*1000})+'\n')
            os.write(sys.stdout.fileno(), (line+'\r\n').encode())
            f.write(line+'\n')
            time.sleep(.025)
threading.Thread(target=output, daemon=True).start()
total = 0
with open(os.path.join(root, 'input.bin'), 'ab', buffering=0) as f, open(os.path.join(root, 'input-times.jsonl'), 'w', buffering=1) as times:
    while True:
        data = os.read(sys.stdin.fileno(), 4096)
        if not data: break
        f.write(data)
        total += len(data)
        times.write(json.dumps({'end':total,'time':time.time()*1000})+'\n')
