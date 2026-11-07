-- Fixes from the review research.
alter table projects add column facts text not null default '';
alter table messages add column translation text;
