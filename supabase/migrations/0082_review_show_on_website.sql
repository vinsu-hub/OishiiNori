-- The owner picks which approved reviews appear on the website's Reviews
-- page (GET /public/reviews). Off by default: approving a review still
-- only records it, nothing goes public until someone switches it on.

alter table reviews add column show_on_website boolean not null default false;

create index idx_reviews_on_website on reviews (created_at desc) where show_on_website;
