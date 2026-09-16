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
- `BT_PORT` -- see §2 below, once the printer is paired.

## 2. Pairing the XP-58H over Bluetooth

The XP-58H (also has USB, but this bridge uses Bluetooth SPP so it can sit anywhere near the
kitchen station rather than tethered to one machine). Pairing itself is OS-level -- Python
doesn't manage it, it just opens whatever serial port the OS exposes once paired.

### Windows

1. Settings -> Bluetooth & devices -> Add device -- put the XP-58H in pairing mode (usually
   holding its feed button while powering on; check the printer's manual) and pair it.
2. Settings -> Bluetooth & devices -> Devices -> click the paired printer -> **More Bluetooth
   settings** -> **COM Ports** tab. You'll see an **Outgoing** COM port (e.g. `COM5`) -- that's
   `BT_PORT` in your `.env`.
3. If no COM port appears, remove and re-pair the device -- Windows sometimes needs the SPP
   profile explicitly re-negotiated.

### Linux

1. `bluetoothctl`
   ```
   scan on
   # note the printer's MAC address, e.g. AA:BB:CC:DD:EE:FF
   pair AA:BB:CC:DD:EE:FF
   trust AA:BB:CC:DD:EE:FF
   scan off
   exit
   ```
2. Bind it to an rfcomm device:
   ```
   sudo rfcomm bind 0 AA:BB:CC:DD:EE:FF
   ```
   This creates `/dev/rfcomm0` -- that's `BT_PORT`. (To make this survive a reboot, add an entry
   to `/etc/bluetooth/rfcomm.conf` or a udev rule -- specifics vary by distro.)

### Either OS

`BT_BAUDRATE` defaults to `9600`, the common default for these Bluetooth SPP thermal printers.
If tickets print garbled, try `19200` or `38400`.

## 3. Running

```
python bridge.py --test-print    # sanity-check ticket formatting, no printer/backend needed
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
