-- New roles: `stocker` (stock/inventory-only dashboard access) and `rider`
-- (delivery-tab-only access, Phase 6). Postgres won't let a value added by
-- ALTER TYPE ... ADD VALUE be referenced in the same transaction it was
-- added in -- this migration does ONLY the enum change, on its own, so it
-- can be applied and committed before migration 0038+ (or any app code)
-- tries to write/compare against these values.

alter type user_role add value 'stocker';
alter type user_role add value 'rider';
