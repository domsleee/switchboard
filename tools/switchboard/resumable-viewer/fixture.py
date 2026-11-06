"""Raw-mode fixture; record application-observed input, emit numbered output."""
import os, sys, threading, time, json
root = sys.argv[1]
if os.name == 'nt':
    import ctypes, msvcrt
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetConsoleMode.restype = wintypes.BOOL
    kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.SetConsoleMode.restype = wintypes.BOOL
    for standard, clear, enable in [(-10, 7, 0x200), (-11, 0, 4)]:
        mode = wintypes.DWORD()
        handle = kernel.GetStdHandle(standard & 0xffffffff)
        if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.SetConsoleMode(handle, (mode.value & ~clear) | enable):
            raise ctypes.WinError(ctypes.get_last_error())
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
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
