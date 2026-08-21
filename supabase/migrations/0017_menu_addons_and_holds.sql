-- Add-ons and ingredient-hold customization for the digital menu.
-- Requested by the user when merging a new customer-menu UI design that
-- included both features (see SESSION_HANDOFF.md). Neither exists anywhere
-- else in this system (not even POS Terminal has item modifiers) -- these
-- are digital-menu-only concepts for now, deliberately NOT wired into
-- recipe/ingredient deduction:
--   - menu_addons: a small, staff-manageable price list (extra egg, extra
--     shrimp, etc.), seeded with the 5 the UI design shipped with. Priced
--     and taxed like a real line item, but has no recipe_items of its own.
--   - digital_order_items.held_ingredients: informational text for the
--     kitchen (e.g. "no wasabi"), drawn client-side from the product's real
--     recipe_items -- not an automatic recipe recalculation.

create table menu_addons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(12, 2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table digital_order_addons (
  id uuid primary key default gen_random_uuid(),
  digital_order_id uuid not null references digital_orders(id) on delete cascade,
  addon_id uuid not null references menu_addons(id) on delete restrict,
  quantity int not null check (quantity > 0),
  unit_price numeric(12, 2) not null
);

create index idx_digital_order_addons_order on digital_order_addons(digital_order_id);

alter table digital_order_items add column held_ingredients text[] not null default '{}';

insert into menu_addons (name, price) values
  ('Extra soft-boiled egg', 35),
  ('Extra noodles', 40),
  ('Extra shrimp', 65),
  ('Extra nori', 20),
  ('Extra scallions', 15);

-- RLS ---------------------------------------------------------------------
alter table menu_addons enable row level security;
alter table digital_order_addons enable row level security;
-- No anon/authenticated policies -- same fail-closed posture as every other
-- table here (all access goes through the FastAPI service-role client).
