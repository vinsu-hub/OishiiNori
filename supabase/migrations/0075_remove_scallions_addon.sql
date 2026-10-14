-- Hide scallions from new orders while preserving historical order references.
update public.menu_addons
set active = false
where lower(name) = 'extra scallions';
