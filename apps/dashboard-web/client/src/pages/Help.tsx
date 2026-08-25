import type { ReactNode } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

interface HelpSection {
  question: string;
  answer: ReactNode;
}

interface HelpGroup {
  title: string;
  sections: HelpSection[];
}

const HELP_GROUPS: HelpGroup[] = [
  {
    title: 'Overview',
    sections: [
      {
        question: 'What is the Command Suite made of?',
        answer: (
          <>
            <p>Four connected apps share one system:</p>
            <ul className="list-disc pl-5 space-y-1 mt-1">
              <li><strong>This dashboard</strong> — POS, kitchen, inventory, HR/payroll, and executive tools.</li>
              <li><strong>Staff Clock</strong> — a shared kiosk device where employees clock in/out with an Employee Number + PIN.</li>
              <li><strong>Customer Menu</strong> — the QR-code menu customers order from on their own phone, no login required.</li>
              <li>All three talk to one backend, so a sale, a stock count, or an approved QR order updates everywhere at once.</li>
            </ul>
          </>
        ),
      },
      {
        question: 'What can each staff role see and do?',
        answer: (
          <>
            <p>Every account has one role, shown in the sidebar footer:</p>
            <ul className="list-disc pl-5 space-y-1 mt-1">
              <li><strong>Employee</strong> — POS, Order Queue, Pending Orders, Kitchen Display, the Stock group's Ingredient Stock/Station Items/Receive Shipment, Loss Log, Utility Log, Settings.</li>
              <li><strong>Manager</strong> — everything above, plus the Stock group's Overview/Alerts/Variance Log, POS Management, Employees, HR Attendance, Payroll, Holiday Calendar, and Payroll Settings.</li>
              <li><strong>Executive</strong> — everything above, plus Command Center, Trend Analysis, Menu Editing, P&amp;L, Oishii AI, and this Help page. Executives land on Command Center after logging in instead of Home.</li>
            </ul>
            <p className="mt-1">The sidebar only shows what a role can use — if something isn't listed here, that section is not relevant to your role.</p>
          </>
        ),
      },
    ],
  },
  {
    title: 'Customer ordering (QR Menu)',
    sections: [
      {
        question: 'How does a customer order from their table?',
        answer: (
          <p>
            Each table has a printed QR code. Scanning it opens the menu on the customer's own phone — no app, no
            login. They browse by category, pick a size and any add-ons, and can ask to hold an ingredient (e.g. "no
            cucumber"), which is pulled straight from that item's real recipe. After checkout they choose Cash or
            GCash and submit — nothing is charged in-app, a staff member confirms payment in person.
          </p>
        ),
      },
      {
        question: 'Where do QR orders show up for staff?',
        answer: (
          <p>
            Every submitted order lands on <strong>Pending Orders</strong> first — it is not a real sale yet.
            Approving it there turns it into a normal transaction (it then appears on Kitchen Display and deducts
            stock automatically); declining it requires a reason and never touches inventory. The customer's screen
            polls automatically and updates the moment staff act.
          </p>
        ),
      },
    ],
  },
  {
    title: 'Front of house — POS, Orders, Kitchen',
    sections: [
      {
        question: 'How do I ring up a sale?',
        answer: (
          <p>
            Use <strong>POS Terminal</strong>: tap items into the cart, apply a discount if needed, and Charge. To
            hold an ingredient for a walk-in customer, open the order editor and check the ingredients to exclude —
            those are skipped entirely, not deducted and reversed. You can also park a cart with <strong>Held
            Orders</strong> and resume it later, and star frequently-sold items as <strong>Favorites</strong> for
            quick access.
          </p>
        ),
      },
      {
        question: 'How do refunds/mistakes work?',
        answer: (
          <p>
            Void a sale from <strong>Order Queue</strong>. Voiding restores exactly the stock that sale deducted —
            nothing more — and correctly leaves any held ingredients untouched, since they were never deducted in
            the first place.
          </p>
        ),
      },
      {
        question: 'How does the kitchen track orders?',
        answer: (
          <p>
            <strong>Kitchen Display</strong> shows every order by station and moves it forward through
            queued → preparing → ready → completed. Bundle items like Sushi Boat don't have their own recipe — the
            kitchen logs which specific rolls were used via "Log rolls used," and those rolls' recipes are what
            actually get deducted. If prep uses more of an ingredient than the recipe calls for (an extra egg, more
            mayo), log it right there with "Log extra usage" instead of waiting until the next stock count.
          </p>
        ),
      },
    ],
  },
  {
    title: 'Stock & inventory',
    sections: [
      {
        question: 'Do I need to count stock by hand every day?',
        answer: (
          <p>
            No — that's the biggest change from the old paper process. Every POS and QR sale already knows its
            recipe and deducts the exact ingredients the moment the sale happens, correctly skipping anything a
            customer held. Physical counting on the <strong>Stock</strong> page is now a periodic accuracy check,
            not the main way stock gets tracked.
          </p>
        ),
      },
      {
        question: 'What are the pages inside the Stock group?',
        answer: (
          <>
            <p>
              The sidebar's <strong>Stock &amp; Inventory</strong> group holds six pages, in order:
            </p>
            <p className="mt-1">
              <strong>Overview</strong> (manager/executive) — a landing dashboard: low-stock count, expiring-soon
              items, a per-station breakdown, and recent movements, each linking straight to the page that can act
              on it.
            </p>
            <p className="mt-1">
              <strong>Ingredient Stock</strong> — the source of truth for anything used in a recipe and driving food
              cost. New Stocks/Beginning/Usage/Ending are auto-filled from real sales, deliveries and logged losses
              -- anyone can flag a field with a reason if it looks wrong, which writes an audited correction rather
              than a silent overwrite. Managers/executives can also edit an ingredient's details (base unit,
              category, reorder threshold).
            </p>
            <p className="mt-1">
              <strong>Station Items</strong> — everything on the old paper stock sheets that has no recipe at all
              (packaging, supplies, resale drinks), organized by physical station. If an item is also a recipe
              ingredient, its stock number is read-only here and links to the Ingredient Stock tab, so there's
              only ever one place that actually changes that figure.
            </p>
            <p className="mt-1">
              <strong>Receive Shipment</strong> — log what came in from a supplier.
            </p>
            <p className="mt-1">
              <strong>Alerts</strong> (manager/executive) — every real low-stock/expiring/verify-needed item in one
              filterable table, with a "Count now" button that jumps straight to the right tab (and station).
            </p>
            <p className="mt-1">
              <strong>Variance Log</strong> (manager/executive) — a chronological history of real loss records and
              count adjustments, with signed variance, cost impact, and who recorded it.
            </p>
          </>
        ),
      },
      {
        question: 'How do I log a delivery, spoilage, or a utility bill?',
        answer: (
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Receive Shipment</strong> — log what came in from a supplier (quantity, unit cost, expiry).</li>
            <li><strong>Loss Log</strong> — spoilage, breakage, comps, or shrinkage not tied to a specific kitchen order.</li>
            <li><strong>Utility Log</strong> — electricity/water/gas meter readings; cost is computed automatically.</li>
          </ul>
        ),
      },
      {
        question: "How do I know when something's running low?",
        answer: (
          <p>
            A red badge appears next to the <strong>Stock &amp; Inventory</strong> group (and again next to
            <strong> Alerts</strong>) in the sidebar, and a card on Home, the moment anything hits its reorder
            threshold — you don't need to go looking for it. Managers/executives can see the full list on
            <strong> Alerts</strong> or <strong>Overview</strong>; executives also see it on Command Center.
          </p>
        ),
      },
    ],
  },
  {
    title: 'Menu, pricing & discounts',
    sections: [
      {
        question: 'How do I add or change a menu item?',
        answer: (
          <p>
            <strong>Menu Editing</strong> (executive) — create a new item, edit prices per size, edit the recipe's
            ingredients, and upload a photo. Deactivating an item (instead of deleting it) is how you retire
            something without breaking its sales history.
          </p>
        ),
      },
      {
        question: 'How do I add or change a discount?',
        answer: (
          <p>
            <strong>POS Management</strong> (manager/executive) — create discount types (name, percentage, whether
            it's VAT-exempt). These are what show up in the discount picker on POS Terminal.
          </p>
        ),
      },
    ],
  },
  {
    title: 'Money & reports (executive)',
    sections: [
      {
        question: "What's on Command Center?",
        answer: (
          <p>
            A same-day rollup: revenue, discounts, tax, losses, low-stock count, utility cost, department split, and
            roughly how many staff are clocked in.
          </p>
        ),
      },
      {
        question: "What's on P&L?",
        answer: (
          <p>
            A Today/Week/Month profit &amp; loss view: revenue, gross/net profit, food cost %, and a cost breakdown.
            It's upfront about its own gaps — it flags when a bundle sale has no logged rolls-used yet, and when
            ingredients still need a cost entered, since those directly affect the numbers.
          </p>
        ),
      },
      {
        question: "What's on Trend Analysis?",
        answer: <p>A date-range sales trend chart and a top-selling-products table, computed from real sales.</p>,
      },
    ],
  },
  {
    title: 'Staff, payroll & the clock kiosk',
    sections: [
      {
        question: 'How does clocking in/out work?',
        answer: (
          <p>
            At the shared <strong>Staff Clock</strong> device, enter your Employee Number and PIN, confirm your
            name, then Punch In. Ending your shift shows a preview and a total-hours summary. The screen resets
            itself after 30 seconds of inactivity so it's always ready for the next person, and if the device loses
            internet mid-punch it queues the action and syncs automatically once it's back online.
          </p>
        ),
      },
      {
        question: 'How do I run payroll?',
        answer: (
          <p>
            <strong>Payroll</strong> (manager/executive) — generate a run for a period, preview it, then download
            PDF payslips (single or a bulk ZIP for everyone). <strong>Holiday Calendar</strong> and
            <strong> Payroll Settings</strong> control the holiday dates and pay-rate rules that generation
            calculates against. <strong>Employees</strong> is where staff profiles and clock-in PINs are managed.
          </p>
        ),
      },
    ],
  },
  {
    title: 'Oishii AI',
    sections: [
      {
        question: 'What can I ask Oishii AI?',
        answer: (
          <>
            <p>
              Oishii AI (executive only) answers questions grounded in your real, live data — not generic advice.
              It can pull up revenue, best sellers, what's driving losses, ingredient stock levels, payroll history,
              and individual pay rates, sometimes with a chart.
            </p>
            <p className="mt-1 text-muted-foreground">
              Try: "What's my revenue today?", "What's driving my losses?", "What's my current stock of Sushi rice?"
            </p>
          </>
        ),
      },
    ],
  },
];

export default function Help() {
  return (
    <DashboardLayout title="Help">
      <div className="p-6 space-y-4 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display">How the system works</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              A quick reference for every part of the Command Suite — what each page does and how to use it. Sections
              are grouped the way the work actually flows, from a customer scanning a QR code through to running
              payroll.
            </p>
          </CardContent>
        </Card>

        {HELP_GROUPS.map((group) => (
          <Card key={group.title}>
            <CardHeader>
              <CardTitle className="font-corp-display text-base">{group.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                {group.sections.map((section, i) => (
                  <AccordionItem key={i} value={`${group.title}-${i}`}>
                    <AccordionTrigger className="font-corp-body">{section.question}</AccordionTrigger>
                    <AccordionContent className="text-sm text-muted-foreground font-corp-body">
                      {section.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardLayout>
  );
}
