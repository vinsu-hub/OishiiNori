# Printer Setup: Xiaomi Tablets + XP-58H Printers

Oishii Nori uses **two Xiaomi tablets**, each with its own **Xprinter XP-58H** (58mm thermal, USB+Bluetooth):

| Tablet | Printer | What it prints | When it prints |
|---|---|---|---|
| **Cashier** (POS Terminal) | RECEIPT printer | Customer receipt | Cashier taps **Print receipt** after a sale |
| **Kitchen** (Kitchen Display) | KITCHEN printer | Kitchen order ticket | Kitchen staff tap **Accept** on an order |

The tablets print through the free **RawBT** app, which handles the Bluetooth connection to the printer. Do every step below on **both** tablets unless it says otherwise.

---

## 1. Identify and label the printers

1. With the printer **off**, hold the **FEED** button and switch it **on**.
2. It prints a self-test page showing its Bluetooth name and PIN.
3. Put a sticker on each printer: **KITCHEN** and **RECEIPT**. Both printers are the same model, so they look identical in the Bluetooth list.

## 2. Use Chrome, not Mi Browser

1. Install **Google Chrome** from the Play Store or GetApps.
2. Open the dashboard in Chrome and log in.
3. Tap **⋮ → Add to Home screen** so staff always open it in Chrome.

> Mi Browser (Xiaomi's default browser) may not pass print jobs to RawBT.

## 3. Install RawBT

- **Global tablets:** install **RawBT** from the Play Store.
- **Chinese-version tablets** (no Google Play): download the app from the official site, **rawbt.ru**, and allow **Install unknown apps** for Chrome when asked.

## 4. Pair the printer and set it up in RawBT

1. Go to **Settings → Bluetooth** and pair this tablet's printer (cashier: RECEIPT, kitchen: KITCHEN). The PIN is usually `0000` or `1234`.
2. Open **RawBT** and set:
   - Connection: **Bluetooth**, then choose this tablet's printer
   - Driver: **ESC/POS**
   - Paper: **58mm**
3. Run RawBT's own **test print** to confirm the connection works.

## 5. Stop Xiaomi from closing RawBT

Xiaomi closes background apps very aggressively. If it closes RawBT, printing stops with no error.

1. Go to **Settings → Apps → Manage apps → RawBT** and set:
   - **Autostart:** ON
   - **Battery saver:** No restrictions
   - **Other permissions:** allow **Display pop-up windows while running in the background** and **Start in background**
2. Repeat the same settings for **Chrome**.

## 6. Lock RawBT in recent apps

Open the recent apps view, **long-press RawBT**, then tap the **lock** icon.

## 7. Allow Chrome to open RawBT

The first time you print, the tablet may ask whether Chrome can open RawBT. Choose **Always allow**.

If it was denied by mistake: **Security app → Permissions → App chain launch** (the name varies by version), then allow Chrome to open RawBT.

## 8. Keep the screen awake

**Settings → Display → Sleep → Never** (or the longest option) while the tablet is plugged in.

## 9. Turn on printing in the dashboard

**Cashier tablet:**
1. Open **Printer Setup**.
2. Under *POS Receipt Printer*, choose **RawBT (Android tablet)**.
3. Tap **Print test receipt**. A sample receipt should print.

**Kitchen tablet:**
1. Open **Kitchen Display**.
2. Tap **Print tickets on this tablet** (the button turns solid).
3. Tap **Test ticket**. A sample ticket should print.

> These settings only apply to the tablet you set them on. Other phones or computers that open the same pages won't print.

---

## 10. Final check

1. **After sleep:** lock the screen for 10+ minutes, unlock, and print again.
2. **A real sale:**
   1. Charge an order on the cashier tablet and tap **Print receipt**. The receipt should print.
   2. On the kitchen tablet, tap **Accept** on that order. The kitchen ticket should print.
   3. In **Printer Setup** (on any device), *Kitchen Ticket Printer* should show **Online** with that order number.

---

## Day-to-day

- **Kitchen ticket didn't print / paper jammed:** tap **Reprint ticket** on the order (shown on Preparing and Ready orders).
- **Nothing prints at all:**
  1. Check the printer is on and has paper.
  2. Open RawBT directly. If it lost the printer, choose it again.
  3. Recheck step 5 (Xiaomi may have reset the battery settings after an update).
- **Kitchen shows Offline in Printer Setup:** the kitchen tablet's Kitchen Display is closed, or printing was switched off there. "Online" only means the page is open with printing on. It can't confirm the printer itself, so use **Test ticket** to check the printer.
- **Don't** also run the Windows `kitchen-print-bridge` program for the kitchen printer, or every ticket will print twice.

---

# Table QR Ordering

Each table has a QR sticker. Customers scan it, order on their phone, and the order goes to the **cashier** to approve before the kitchen starts.

## Print and stick the QR codes

1. On a computer, open the dashboard → **Reservations → Table QR Codes**.
2. Tap **Print all**. It prints on A4, 6 codes per page.
3. Cut along the dashed lines and stick each code on **its own table**. Table numbers match the Floor Plan (Reservations → Floor Plan).

Each code opens `https://www.oishiinori.com/menu?table=N`, so the order arrives already marked for that table. Use **Open** on a card to test a link before printing.

## How an order flows

1. **Customer** scans the sticker, picks items, chooses how they'll pay, and submits.
2. **Cashier tablet** chimes and shows a pop-up on any page: *"New table order — Table 5"*. The sidebar's **Table Orders** shows how many are waiting.
3. **Cashier** taps **Review** (or opens Table Orders), checks the order, then taps **Approve**. Use **Decline** for a prank or a mistake.
4. **Kitchen tablet:** the approved order appears on Kitchen Display. The kitchen taps **Accept** and the ticket prints.
5. The order also shows on that table in **Floor Plan** and in **Order Queue**. Payment is collected at the counter.

## Notes

- **Tap the cashier tablet once after logging in** so the browser allows sound. Otherwise the chime stays silent until the first tap.
- The kitchen tablet doesn't chime for orders waiting for approval, only once they're approved.
- An order for a table number that doesn't exist is rejected, and the customer is asked to see a staff member.
- Orders only go through while the business day is open.

---

# New Staff Onboarding

Each staff member has their own **employee ID** (e.g. `EMP-30F5`), a **login email**, a **temporary password**, and a private **4-digit time-clock PIN**.

## Giving someone their login

- **New hire:** Employees → **Add employee**. The dialog shows their email, employee ID, temporary password and PIN. Write them down for the person.
- **Forgot password:** Employees → **Reset password** on their row. It shows a new temporary password once.
- **Forgot PIN:** Employees → **Set PIN**.
- Executives can see a temporary password again in **View credentials**. Once the employee sets their own password, it shows *"Changed by employee"*. Their own password is never stored where anyone can read it.

## First login (the employee does this)

1. Open **https://www.oishiinori.com/dashboard**.
2. Sign in with their **employee ID** (or email) and the **temporary password**.
3. They're taken straight to **Set your own password**: at least 8 characters, and not the temporary one.
4. After that they use their own password every time.

## Time in / time out

1. Open **https://www.oishiinori.com/staff-clock** on the shared clock device.
2. Enter **employee ID + PIN**, then tap **Time in** at the start of the shift and **End today's work** at the end.
3. One shift per day. A shift left open for 16+ hours is closed automatically and flagged for a manager to review.
