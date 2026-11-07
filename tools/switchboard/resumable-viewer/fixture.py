"""Raw-mode fixture; record application-observed input, emit numbered output."""
import os, sys, threading, time, json
root = sys.argv[1]
if os.name == 'nt':
    import ctypes, msvcrt, codecs
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetConsoleMode.restype = wintypes.BOOL
    kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.SetConsoleMode.restype = wintypes.BOOL
    # os.read/os.write use bytes; match the UTF-8 stream delivered through ConPTY.
    if not kernel.SetConsoleCP(65001) or not kernel.SetConsoleOutputCP(65001):
        raise ctypes.WinError(ctypes.get_last_error())
    for standard, clear, enable in [(-10, 7, 0x200), (-11, 0, 4)]:
        mode = wintypes.DWORD()
        handle = kernel.GetStdHandle(standard & 0xffffffff)
        if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.SetConsoleMode(handle, (mode.value & ~clear) | enable):
            raise ctypes.WinError(ctypes.get_last_error())
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    # ReadFile's console byte conversion can replace each half of a surrogate pair.
    # Read UTF-16 console characters and retain a high surrogate until its pair arrives.
    console_decoder = codecs.getincrementaldecoder('utf-16-le')()
    def read_input():
        while True:
            text = console_decoder.decode(msvcrt.getwch().encode('utf-16-le', 'surrogatepass'))
            if text: return text.encode('utf-8')
else:
    import tty
    tty.setraw(sys.stdin.fileno())
    def read_input(): return os.read(sys.stdin.fileno(), 4096)
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
        data = read_input()
        if not data: break
        f.write(data)
        total += len(data)
        times.write(json.dumps({'end':total,'time':time.time()*1000})+'\n')
