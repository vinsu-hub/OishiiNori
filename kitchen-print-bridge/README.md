# Kitchen Print Bridge

A small local service that watches the Oishii Nori Command Suite's Kitchen Display orders and
prints a physical prep ticket on an **Xprinter XP-58H** (58mm thermal, ESC/POS, Bluetooth
Classic/SPP) the moment a kitchen staffer **accepts** an order (advances it from `queued` to
`preparing`). It runs on a machine/tablet physically next to the printer -- the printer is only
reachable over Bluetooth SPP, which a browser can't do, so this can't live in the Vercel-hosted
dashboard itself.

It polls, like everything else in this project (no websockets), every 20 seconds by default --
same interval the Kitchen Display frontend already uses.

## 1. First-time setup

### 1a. Create a dedicated backend account for the bridge

This backend has no API-key/service-account mechanism -- every request needs a real signed-in
user. Create one low-privilege account just for this bridge (any role works; it only ever calls
`GET /transactions` and `GET /products`):

1. Sign in to the dashboard as an executive.
2. Employees -> Add Employee -- name it something recognizable like "Kitchen Printer", role
   `employee`, no real pay rate needed.
3. Set it up with a login email + password the same way any staff account gets one.

### 1b. Install Python dependencies

Requires Python 3.10+.

```
cd kitchen-print-bridge
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # Linux/macOS
pip install -r requirements.txt
```

### 1c. Configure

```
copy .env.example .env        # Windows
# cp .env.example .env        # Linux/macOS
```

Fill in:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` -- same values `services/api-fastapi/.env.local` or the
  dashboard's `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` use.
- `BRIDGE_EMAIL` / `BRIDGE_PASSWORD` -- the account from step 1a.
- `BT_PORT` -- leave as-is; §2 below sets this for you, no manual editing needed.

## 2. Pairing the XP-58H, then pointing the bridge at it

Pairing itself is always OS-level, for either connection type -- Bluetooth or USB -- no app
(this one included) can do that handshake for you:

- **Bluetooth:** pair the XP-58H in the device's own Bluetooth settings (Windows: Settings ->
  Bluetooth & devices -> Add device; Android: Settings -> Connected devices; put the printer in
  pairing mode first -- usually holding its feed button while powering on, check the printer's
  manual).
- **USB:** just plug it in. Windows will install a driver automatically for this class of
  printer; if it doesn't, install the Xprinter driver package from the printer's manual/box.

Once paired/plugged in, **run the setup page** instead of hunting for a COM port by hand:

```
python bridge.py --setup
```

This opens a local page in your browser with a **Scan for ports** button -- it lists every
serial port the OS currently exposes (this covers both a paired Bluetooth printer and most USB
thermal printers, since this class of printer typically exposes a virtual serial port either
way). Click **Test print** next to the one you think is the printer to confirm it (prints a
short "OISHII NORI / Test print OK" ticket), then **Use this printer** to save it into `.env` --
no manual file editing. Restart the bridge afterward to pick up the change.

If the printer never appears in the scan after pairing/plugging in, try Scan again (some OSes
take a moment to expose the port); a printer with *no* virtual serial port at all -- pure
USB-printer-class, no COM/tty -- won't show up here and needs a different backend than this
bridge currently implements.

`BT_BAUDRATE` (also set by the setup page) defaults to `9600`, the common default for these
printers. If tickets print garbled, try `19200` or `38400` from the setup page's dropdown.

### Linux (manual fallback)

The setup page's port scan works on Linux too, but pairing still needs `bluetoothctl` first:
```
bluetoothctl
scan on
# note the printer's MAC address, e.g. AA:BB:CC:DD:EE:FF
pair AA:BB:CC:DD:EE:FF
trust AA:BB:CC:DD:EE:FF
scan off
exit
```
Some distros also need it explicitly bound to an rfcomm device before it shows up as a serial
port: `sudo rfcomm bind 0 AA:BB:CC:DD:EE:FF` (creates `/dev/rfcomm0`; to survive a reboot, add an
entry to `/etc/bluetooth/rfcomm.conf` or a udev rule -- specifics vary by distro).

## 3. Running

```
python bridge.py --test-print    # sanity-check ticket formatting, no printer/backend needed
python bridge.py --setup         # scan for the printer's port, test print, save it (see above)
python bridge.py --once          # one poll cycle then exit -- good for a first live test
python bridge.py                 # runs continuously until Ctrl+C
```

### Testing ticket formatting without a paired printer

`--test-print` renders a sample delivery order ticket and writes two files into this directory:
- `test_ticket.bin` -- the raw ESC/POS bytes exactly as they'd be sent to the printer.
- `test_ticket.txt` -- a human-readable text preview of the same ticket, also printed to the
  console.

Use this to check line-width wrapping, held-ingredient/add-on formatting, etc. before ever
touching Bluetooth.

### What triggers a print

A ticket prints once, the first time an order's `kitchen_status` is seen as `preparing` (i.e.
right after kitchen staff hit Accept on the Kitchen Display) -- never on arrival at `queued`,
and never again once printed, even if it stays in `preparing` for a while or the bridge restarts
(tracked in `printed_tickets.db`, a small local SQLite file).

## 4. Troubleshooting

- **"Missing required setting(s) ..."** -- `.env` isn't filled in; see §1c.
- **Login failures logged repeatedly** -- double-check `BRIDGE_EMAIL`/`BRIDGE_PASSWORD`, and
  that account is `active` in Employees.
- **"Failed to print transaction ..." logged, ticket never appears** -- the printer is off, out
  of range, or paired to a different port. The bridge keeps polling and retries the same order
  every cycle; nothing is lost. Check `BT_PORT` and that the printer is powered on and in range,
  then watch the log for the next successful attempt.
- **Nothing ever gets fetched to print** -- confirm an order is actually sitting at
  `kitchen_status: preparing` on the Kitchen Display (not still `queued`), and that
  `API_BASE_URL` points at the right environment.
- All activity (success and failure, with order id/number and timestamp) is logged to
  `bridge.log` in this directory (rotates at ~2MB, keeps 3 backups) as well as the console.

## 5. Files

| File | Purpose |
|---|---|
| `bridge.py` | CLI entry point, poll loop, printer connection lifecycle |
| `api_client.py` | `GET /transactions?kitchen_status=preparing`, `GET /products` |
| `auth.py` | Signs in as the bridge's dedicated account, refreshes the token |
| `ticket.py` | ESC/POS ticket layout (works against a real printer or `--test-print`'s Dummy profile) |
| `state.py` | SQLite dedupe store (`printed_tickets.db`) so nothing double-prints |
| `config.py` | Loads `.env` |
| `setup_ui.py` | `--setup`'s local web page: scan ports, test print, save `BT_PORT`/`BT_BAUDRATE` |
