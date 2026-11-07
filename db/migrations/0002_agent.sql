-- Milestones 2 to 6: AI drafting, lead search, budgets, auto-replies, erasure.

-- A new project can spend up to $5 a day on AI and data. Zero pauses everything.
alter table projects alter column daily_budget_micros set default 5000000;
update projects set daily_budget_micros = 5000000 where daily_budget_micros = 0;
alter table projects add column monthly_cap_micros bigint check (monthly_cap_micros is null or monthly_cap_micros >= 0);

alter table first_emails add column preview jsonb not null default '[]';
alter table first_emails add column auto_reverted_at timestamptz;

alter table campaigns add column use_project_email boolean not null default false;

alter table leads add column fit_score int check (fit_score between 0 and 5);

alter table messages add column needs_draft boolean not null default false;
alter table messages add column intent_reason text;
create index messages_to_draft on messages (created_at) where needs_draft and status = 'queued';
create index messages_to_classify on messages (created_at) where kind = 'reply' and intent is null;
