"""`python bridge.py --setup` -- a small local web page (stdlib http.server
only, no new dependency) that replaces the old "find your COM port by hand
and paste it into .env" flow with Scan / Test print / Save buttons.

Scope, deliberately: this can only *scan* ports the OS already exposes and
*save* the chosen one into .env. It cannot perform the Bluetooth pairing
handshake itself -- no app (native or web) can; that's still a one-time
step in the device's own OS Bluetooth settings (see README.md). What this
removes is the manual "go find which COM5/tty the OS assigned it" step,
for both a Bluetooth-paired printer and a USB one -- this class of thermal
printer (XP-58H) typically exposes a virtual serial port for *either*
connection type, so one scan covers both. If a printer instead only exposes
itself as a USB-printer-class device with no virtual serial port, it won't
appear here -- see the note rendered in the page for that case.
"""

from __future__ import annotations

import json
import logging
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import set_key

from config import Config

logger = logging.getLogger("kitchen_print_bridge")

DEFAULT_UI_PORT = 8765
ENV_TEMPLATE_PATH = Path(__file__).resolve().parent / ".env.example"


def _list_ports() -> list[dict]:
    from serial.tools import list_ports

    ports = []
    for p in sorted(list_ports.comports(), key=lambda p: p.device):
        ports.append(
            {
                "device": p.device,
                # Windows: friendly names like "Standard Serial over Bluetooth
                # link (COM5)". Linux/macOS: often just the device path itself,
                # sometimes a USB descriptor -- whatever the OS gives us, shown
                # as-is so staff can recognize the printer without guessing.
                "description": p.description or "",
                "hwid": p.hwid or "",
            }
        )
    return ports


def _test_print(port: str, baudrate: int) -> None:
    """Opens its own short-lived connection -- deliberately separate from
    the poll loop's persistent PrinterConnection, since this can run while
    the main service isn't (or is) also running. Raises on failure; the
    handler below turns that into a JSON error for the page."""
    from escpos.printer import Serial

    printer = Serial(devfile=port, baudrate=baudrate, timeout=5)
    try:
        printer.set(align="center")
        printer.text("OISHII NORI\n")
        printer.text("Test print OK\n")
        printer.text(f"{port} @ {baudrate} baud\n")
        printer.cut()
    finally:
        printer.close()


def _env_path(config: Config) -> Path:  # noqa: ARG001 -- kept for signature symmetry / future use
    return Path(__file__).resolve().parent / ".env"


def _ensure_env_file(env_path: Path) -> None:
    if env_path.exists():
        return
    if ENV_TEMPLATE_PATH.exists():
        env_path.write_text(ENV_TEMPLATE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        logger.info("Created %s from .env.example", env_path)
    else:
        env_path.touch()


PAGE_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Kitchen Print Bridge -- Printer Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 20px; } p.hint { color: #555; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; font-size: 14px; }
  button { cursor: pointer; padding: 6px 12px; border-radius: 6px; border: 1px solid #999; background: #f5f5f5; font-size: 13px; }
  button:hover { background: #eee; }
  button.primary { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  button.primary:hover { background: #333; }
  .current { font-weight: 600; }
  .msg { margin-top: 8px; padding: 8px 10px; border-radius: 6px; font-size: 14px; display: none; }
  .msg.ok { background: #e6f7e6; color: #146c14; display: block; }
  .msg.err { background: #fbe6e6; color: #8a1c1c; display: block; }
  .row-actions { display: flex; gap: 6px; }
  select#baud { padding: 4px; }
</style></head>
<body>
  <h1>Kitchen Print Bridge &mdash; Printer Setup</h1>
  <p class="hint">Pair the printer in this device's own Bluetooth settings first (one-time --
    this page can't do that part). Then click Scan and pick it from the list below.</p>
  <p>Baud rate: <select id="baud">
    <option value="9600" selected>9600 (default)</option>
    <option value="19200">19200</option>
    <option value="38400">38400</option>
  </select></p>
  <p><button class="primary" onclick="scan()">Scan for ports</button>
     <span id="currentLabel"></span></p>
  <table id="portsTable" style="display:none">
    <thead><tr><th>Port</th><th>Description</th><th></th></tr></thead>
    <tbody id="portsBody"></tbody>
  </table>
  <div id="msg" class="msg"></div>
  <p class="hint">If your printer doesn't appear after pairing/plugging in, try Scan again --
    some OSes take a moment to expose the port. A printer with no virtual serial port at all
    (pure USB-printer-class, no COM/tty) won't show up here and needs a different setup.</p>

<script>
const CURRENT_PORT = %CURRENT_PORT_JSON%;
const CURRENT_BAUD = %CURRENT_BAUD_JSON%;
document.getElementById('currentLabel').textContent = CURRENT_PORT
  ? `Currently saved: ${CURRENT_PORT} @ ${CURRENT_BAUD} baud` : 'No port saved yet';
if (CURRENT_BAUD) document.getElementById('baud').value = String(CURRENT_BAUD);

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function scan() {
  showMsg('Scanning...', true);
  const res = await fetch('/api/ports');
  const ports = await res.json();
  const body = document.getElementById('portsBody');
  body.innerHTML = '';
  if (ports.length === 0) {
    showMsg('No ports found. Pair/plug in the printer, then Scan again.', false);
    document.getElementById('portsTable').style.display = 'none';
    return;
  }
  for (const p of ports) {
    const tr = document.createElement('tr');
    const isCurrent = p.device === CURRENT_PORT;
    tr.innerHTML = `
      <td class="${isCurrent ? 'current' : ''}">${p.device}${isCurrent ? ' (saved)' : ''}</td>
      <td>${p.description || ''}</td>
      <td class="row-actions">
        <button onclick="testPrint('${p.device}')">Test print</button>
        <button class="primary" onclick="save('${p.device}')">Use this printer</button>
      </td>`;
    body.appendChild(tr);
  }
  document.getElementById('portsTable').style.display = '';
  showMsg(`Found ${ports.length} port(s).`, true);
}

async function testPrint(device) {
  const baud = document.getElementById('baud').value;
  showMsg(`Printing a test ticket on ${device}...`, true);
  const res = await fetch('/api/test-print', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({port: device, baudrate: Number(baud)}),
  });
  const data = await res.json();
  if (data.ok) showMsg(`Test ticket sent to ${device}. Check the printer.`, true);
  else showMsg(`Failed on ${device}: ${data.error}`, false);
}

async function save(device) {
  const baud = document.getElementById('baud').value;
  const res = await fetch('/api/save', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({port: device, baudrate: Number(baud)}),
  });
  const data = await res.json();
  if (data.ok) {
    showMsg(`Saved. BT_PORT=${device} in .env -- restart the bridge to use it.`, true);
  } else {
    showMsg(`Could not save: ${data.error}`, false);
  }
}
</script>
</body></html>
"""


def _make_handler(config: Config, env_path: Path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # noqa: A003 -- match BaseHTTPRequestHandler's signature
            logger.info("setup-ui: " + fmt, *args)

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 -- BaseHTTPRequestHandler's naming convention
            if self.path == "/":
                html = PAGE_HTML.replace(
                    "%CURRENT_PORT_JSON%", json.dumps(config.bt_port if config.bt_port != "COM5" else "")
                ).replace("%CURRENT_BAUD_JSON%", json.dumps(config.bt_baudrate))
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/api/ports":
                try:
                    self._send_json(200, _list_ports())
                except Exception as e:  # noqa: BLE001 -- report to the page, never 500 silently
                    self._send_json(500, {"error": str(e)})
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._send_json(400, {"ok": False, "error": "Malformed request"})
                return

            if self.path == "/api/test-print":
                port = str(payload.get("port", ""))
                baudrate = int(payload.get("baudrate", 9600))
                if not port:
                    self._send_json(400, {"ok": False, "error": "No port given"})
                    return
                try:
                    _test_print(port, baudrate)
                    self._send_json(200, {"ok": True})
                except Exception as e:  # noqa: BLE001 -- printer off/wrong port/etc; report, don't crash the server
                    logger.warning("Test print on %s failed: %r", port, e)
                    self._send_json(200, {"ok": False, "error": str(e)})
                return

            if self.path == "/api/save":
                port = str(payload.get("port", ""))
                baudrate = int(payload.get("baudrate", 9600))
                if not port:
                    self._send_json(400, {"ok": False, "error": "No port given"})
                    return
                try:
                    _ensure_env_file(env_path)
                    set_key(str(env_path), "BT_PORT", port)
                    set_key(str(env_path), "BT_BAUDRATE", str(baudrate))
                    logger.info("Saved BT_PORT=%s BT_BAUDRATE=%s to %s", port, baudrate, env_path)
                    self._send_json(200, {"ok": True})
                except Exception as e:  # noqa: BLE001
                    self._send_json(500, {"ok": False, "error": str(e)})
                return

            self.send_response(404)
            self.end_headers()

    return Handler


def run_setup_ui(config: Config, port: int = DEFAULT_UI_PORT) -> None:
    env_path = _env_path(config)
    handler = _make_handler(config, env_path)

    server = None
    # A previous run's server, or anything else, may already hold the default
    # port -- try a short range rather than failing outright.
    for candidate in range(port, port + 10):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise RuntimeError(f"Could not bind any port in {port}-{port + 9} for the setup UI")

    url = f"http://127.0.0.1:{port}/"
    print(f"Printer setup page: {url}")
    print("Opening your browser... (Ctrl+C here to stop)")
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        print("Setup server stopped.")
