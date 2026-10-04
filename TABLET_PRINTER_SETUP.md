# Oishii Nori Tablet and Printer Setup Guide

Use this guide to set up the cashier tablet, kitchen tablet, their printers, and the customer TV queue board. Keep each tablet with its own printer.

## Overview

| Tablet | Printer label | What it prints | When it prints |
|---|---|---|---|
| CASHIER — POS Terminal | RECEIPT | Customer order slip | The cashier taps "Print order slip" after "Charge". |
| KITCHEN — Kitchen Display | KITCHEN | Kitchen prep ticket | A kitchen staff member taps "Accept" on an order. |

Both printers are Xprinter XP-58H thermal printers. They use 58 mm paper and can connect by Bluetooth or USB. This guide uses Bluetooth and the free RawBT app.

> Important: Do not run the Windows `kitchen-print-bridge` for the KITCHEN printer while the kitchen tablet uses RawBT. The same ticket will print twice.

## What you need

1. The two Xiaomi Android tablets: CASHIER and KITCHEN.
2. Two Xprinter XP-58H printers, one for RECEIPT and one for KITCHEN.
3. 58 mm thermal paper rolls.
4. Chargers for both tablets and both printers.
5. Working Wi-Fi for the tablets and TV.
6. Google Chrome on both tablets. Do not use Mi Browser.

## Label and identify the printers

The printers look alike. Label them before pairing.

1. Turn one printer off.
2. Hold the **FEED** button.
3. While holding **FEED**, turn the printer on.
4. The printer prints a self-test page. Find its Bluetooth name and PIN on that page.
5. Put a sticker on it: **RECEIPT** for the cashier printer, or **KITCHEN** for the kitchen printer.
6. Repeat for the other printer. Keep the self-test pages until setup is complete.

## Set up each tablet

Do these steps on both tablets. Pair CASHIER only with RECEIPT. Pair KITCHEN only with KITCHEN.

### 1. Open the dashboard in Chrome

1. Open Google Chrome.
2. Go to `https://www.oishiinori.com/dashboard` and sign in.
3. In Chrome, tap the three-dot menu, then "Add to Home screen".
4. Use this new home-screen icon for the dashboard every day.

Mi Browser may not pass print jobs to RawBT. Always use Chrome.

### 2. Pair the correct printer by Bluetooth

1. Turn on the tablet and its labelled printer.
2. On the tablet, open Android Settings, then Bluetooth or Connected devices.
3. Choose the Bluetooth name shown on that printer's self-test page.
4. If asked for a PIN, try `0000`, then `1234`.
5. Confirm that the paired name is the right labelled printer before continuing.

### 3. Install and set up RawBT

1. Open the Play Store and install **RawBT**.
2. On a China-ROM tablet without Google Play, use Chrome to download RawBT from `rawbt.ru`. When asked, allow Chrome to install the app.
3. Open RawBT.
4. Set the connection to Bluetooth and select this tablet's printer.
5. Set the driver to ESC/POS.
6. Set the paper width to 58 mm.
7. Use RawBT's own test print. Check that it prints on the correct printer.

### 4. Stop Xiaomi from closing printing

Do this for both RawBT and Chrome.

1. Go to Settings, Apps, Manage apps, then open RawBT.
2. Turn Autostart on.
3. Set Battery saver to No restrictions.
4. In Other permissions, allow "Display pop-up windows while running in the background" and "Start in background".
5. Repeat steps 1–4 for Chrome.
6. Open recent apps. Long-press RawBT and tap the lock icon.
7. On the first print, if the tablet asks whether Chrome can open RawBT, choose "Always allow".
8. If this was denied, open the Security app, then Permissions, then App chain launch (the name can vary), and allow Chrome to open RawBT.
9. Set Display, Sleep to Never, or to the longest available time while the tablet is plugged in.

## Lock each tablet to its job, then turn on printing

Each tablet is locked to one job in "Printer Setup" → "This tablet is…". The lock is what guarantees the KITCHEN printer can never print a customer slip, and the cashier tablet can never print kitchen tickets. Only a manager can open Printer Setup.

| Lock | What it allows | What it blocks |
|---|---|---|
| Cashier counter | Customer order slips | Kitchen tickets (the toggle on Kitchen Display is removed) |
| Kitchen | Kitchen tickets, always on | Customer slips ("Print order slip" is replaced by a message) and charging sales on POS |
| Other device | Nothing unless switched on per page | — |

### CASHIER: customer order-slip printing

1. On CASHIER, sign in with a cashier or manager account.
2. Open "Printer Setup" (a manager signs in for this step).
3. Under "This tablet is…", tap "Cashier counter".
4. Under "POS Receipt Printer", select "RawBT (Android tablet)".
5. Tap "Print test receipt" and check that the sample prints on RECEIPT.

After a real sale, tap "Charge". On the sale-complete screen, tap "Print order slip" once. The slip has a large order number and says "This is not an official receipt".

### KITCHEN: prep-ticket printing

1. On KITCHEN, a manager signs in and opens "Printer Setup".
2. Under "This tablet is…", tap "Kitchen".
3. Sign out, then sign in with the **Kitchen Tablet** account (its employee ID and password are on the separate login sheet). On first sign-in it asks for a new password; choose one and give it only to kitchen leads.
4. The tablet opens straight to "Kitchen Display", showing "Kitchen tablet — tickets print here".
5. Tap "Test ticket" and check that the sample prints on KITCHEN.
6. Leave the tablet signed in.

When staff tap "Accept", the order moves to preparing and the kitchen ticket prints. If paper jams or a ticket is missing, use "Reprint ticket" on an order that is preparing or ready.

The Kitchen Tablet account can only see Kitchen Display and Order Queue. It cannot open POS, charge sales, void orders, request refunds or print customer slips, even if someone types another address.

## Set up the TV queue board

1. On the TV or its connected browser, open `https://www.oishiinori.com/menu/tv`.
2. Make the browser full screen.
3. Keep the TV connected to Wi-Fi and leave this page open.

The large order number on the customer order slip is the same number shown on the TV. After the kitchen taps "Accept", it appears under "Now Preparing". After the kitchen taps "Mark Ready", it appears under "Now Serving". Customers can watch the TV and collect their order when their number appears under "Now Serving".

## Daily order flow

1. Cashier takes the order and taps "Charge".
2. Cashier taps "Print order slip" and gives the order slip to the customer.
3. Customer watches the TV queue board for the large order number.
4. Kitchen sees the order in "Kitchen Display" and taps "Accept". The KITCHEN ticket prints and the number appears under "Now Preparing".
5. When the food is ready, kitchen taps "Mark Ready". The number moves to "Now Serving".
6. After handoff, kitchen taps "Complete".

## Troubleshooting

| Problem | What to do |
|---|---|
| Nothing prints | Check that the printer is on, has 58 mm paper, and is near the tablet. Open RawBT directly. If it lost the printer, select the correct printer again and run RawBT's test print. Check the Xiaomi battery and background settings again. |
| It prints on the wrong printer | Stop using the dashboard. In Android Bluetooth and RawBT, forget or disconnect the wrong printer, then select the printer with the correct RECEIPT or KITCHEN label. Run a test print before taking orders. |
| Tickets print twice | Turn off the Windows `kitchen-print-bridge` for that kitchen printer. Use only RawBT on KITCHEN, not both systems. |
| Printing stopped after a Xiaomi or RawBT update | Open RawBT, reconnect to the correct printer, and check Autostart, No restrictions, background pop-ups, the recents lock, and Chrome permission to open RawBT. Test again. |
| A kitchen ticket is missing or paper jammed | Fix the paper or jam, then tap "Reprint ticket" on the preparing or ready order. |
| "Online" appears in "Printer Setup" but no ticket prints | "Online" only means KITCHEN has "Kitchen Display" open with printing on. It does not confirm the printer connection. Tap "Test ticket" and check RawBT. |
| "Print order slip" is missing and a red message says this is the kitchen tablet | This device is locked as Kitchen (or signed in as Kitchen Tablet). Customer slips only print at the cashier — that's the safeguard working. If this really is the cashier tablet, a manager sets Printer Setup → "This tablet is…" → "Cashier counter". |
| The customer slip has wrong shop details | In the dashboard, open "Settings", then "Receipt details", and correct the details. Print a test receipt to confirm. |

## Optional: use USB for the KITCHEN printer

If Bluetooth is unreliable, connect the KITCHEN printer to the KITCHEN tablet with a suitable USB cable or USB adapter. In RawBT, change the connection to USB, choose the KITCHEN printer, keep ESC/POS and 58 mm selected, and use RawBT's test print. Then return to "Kitchen Display" and tap "Test ticket".

Use only one connection method at a time for the KITCHEN printer. If you change between Bluetooth and USB, test before service begins.
