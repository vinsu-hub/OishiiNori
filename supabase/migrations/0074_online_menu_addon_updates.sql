-- Keep the customer menu and POS add-ons aligned through the shared catalog.
update public.menu_addons
set price = case
        when lower(name) = 'extra nori' then 35
        when lower(name) in ('extra scallions', 'extra soft-boiled egg') then 25
        else price
    end
where lower(name) in ('extra nori', 'extra scallions', 'extra soft-boiled egg');

-- Preserve historical order references while hiding shrimp from new orders.
update public.menu_addons
set active = false
where lower(name) = 'extra shrimp';
