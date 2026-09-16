# TODO

Nothing pending right now. Everything below is a record of what was done, kept for context.

## Done

- **Customer Reviews smoke test** — submitted a real review via the public API, confirmed it
  appeared in the dashboard's Pending queue, approved it, confirmed it moved to History. Clean.
- **Customer Reviews: optional photo upload** — migration `0053` (adds `reviews.photo_url`) and a
  new `review-photos` Storage bucket, both applied/created live. New unauthenticated
  `POST /public/reviews/{id}/photo` (mirrors the existing proof-of-payment upload pattern exactly:
  content-type allowlist, 5MB cap, `pending`-only gate). Landing Page's review form gained an
  optional file input + preview; dashboard's Reviews tab renders a thumbnail (click to open
  full-size) in both Pending and History. Fully end-to-end tested: happy path (upload → publicly
  fetchable URL → visible in dashboard), bad content-type (400), oversized file (400), attaching
  to an already-decided review (400), and a review with no photo still works unchanged. All test
  rows and the one uploaded test storage object deleted afterward, zero residue.
- **Migration `0051` (POS Delivery order type) and `0052` (Customer Reviews) — applied and
  verified end-to-end** in an earlier round (POS Delivery charge → rider queue → completion;
  Reviews submission → moderation → approve/reject, idempotency, rate limiting, anonymity
  scrubbing). See prior `SESSION_HANDOFF.md` entries for full detail.
- Kitchen print bridge ticket formatting re-verified against real order data; 3 real formatting
  bugs found and fixed (unwrapped item lines, a mangled Unicode en-dash, a silently truncated long
  customer name) — see `kitchen-print-bridge/ticket.py`.

## Still outstanding (unrelated to this work, not urgent)

- The dedicated Supabase account the kitchen print bridge should authenticate as ("Kitchen
  Printer") has not been created yet — see `kitchen-print-bridge/README.md` §1a.
- The XP-58H has not been physically paired/tested over Bluetooth — only proofed via
  `--test-print`'s `Dummy` profile and real order data rendered to text/bytes, never a real print.
- None of this work is committed, pushed, or deployed to Vercel yet — the database is ahead of
  the deployed code (safe/backward-compatible), but a commit+push+deploy is needed before any of
  it is actually reachable in production.
