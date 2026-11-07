-- Phase 1 schema. First migration. Postgres 15+.
-- Access rule: no RLS. Every query goes through the data layer, scoped by org_id.
-- Money: integer micro-dollars (*_micros) plus a currency column, because one AI
-- call costs less than a cent. 1 USD = 1,000,000 micros.
-- Times: timestamptz, stored in UTC.
-- Auth.js account, session and verification tables come from its Drizzle adapter.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  email_verified timestamptz,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on memberships (user_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  domain text,
  no_website_answers jsonb,
  status text not null default 'creating'
    check (status in ('creating','ready','failed')),
  failure_reason text,
  analysis jsonb not null default '{}',
  sender_name text not null default '',
  timezone text not null default 'UTC',
  daily_budget_micros bigint not null default 0 check (daily_budget_micros >= 0),
  auto_reply_enabled boolean not null default false,
  auto_reply_delay_minutes int not null default 30
    check (auto_reply_delay_minutes between 5 and 1440),
  booking_url text,
  legal_footer text not null default '',
  legal_basis_confirmed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint has_domain_or_answers
    check (domain is not null or no_website_answers is not null)
);
create index on projects (org_id);
create unique index projects_one_per_domain on projects (org_id, lower(domain))
  where domain is not null and archived_at is null;

create table lead_statuses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);
create index on lead_statuses (org_id);

create table mailboxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  smtp_host text not null,
  smtp_port int not null default 587,
  imap_host text not null,
  imap_port int not null default 993,
  username text not null,
  secret_enc text not null,
  status text not null default 'unverified'
    check (status in ('unverified','active','paused','failing')),
  status_reason text,
  daily_limit int not null default 30 check (daily_limit between 1 and 200),
  imap_uidvalidity bigint,
  imap_last_uid bigint not null default 0,
  last_polled_at timestamptz,
  spf_ok boolean,
  dkim_ok boolean,
  dmarc_ok boolean,
  dns_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, email)
);
create index on mailboxes (project_id, status);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  source text not null default 'discovery' check (source in ('discovery','import')),
  status text not null default 'draft'
    check (status in ('draft','searching','review','sending','stopped','archived')),
  status_before_stop text
    check (status_before_stop in ('searching','review','sending')),
  status_reason text,
  offer text,
  customer_problem text,
  target_role text,
  target_geography text,
  target_company_size text,
  positive_criteria text[] not null default '{}',
  negative_criteria text[] not null default '{}',
  example_clients text[] not null default '{}',
  keywords text,
  instructions text not null default '',
  followup_instructions text not null default '',
  reply_instructions text not null default '',
  language text not null default 'auto',
  send_days int[] not null default '{1,2,3,4,5}',
  send_start_minute int not null default 540 check (send_start_minute between 0 and 1439),
  send_end_minute int not null default 1020 check (send_end_minute between 1 and 1440),
  max_touches int not null default 3 check (max_touches between 1 and 6),
  followup_delay_days int not null default 3 check (followup_delay_days between 1 and 30),
  approved_at timestamptz,
  approved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint send_window_order check (send_end_minute > send_start_minute),
  constraint sending_needs_approval
    check (status <> 'sending' or approved_at is not null)
);
create index on campaigns (org_id);
create index on campaigns (project_id, status);
create index on campaigns (approved_by);

-- One row for the project default, or one per campaign that overrides it.
create table first_emails (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  mode text not null default 'instructions' check (mode in ('instructions','my_copy')),
  subject text not null default '',
  body text not null default '',
  instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint one_owner check ((project_id is null) <> (campaign_id is null))
);
create index on first_emails (org_id);
create unique index first_emails_project on first_emails (project_id) where project_id is not null;
create unique index first_emails_campaign on first_emails (campaign_id) where campaign_id is not null;

-- One person per org, across campaigns. Erasure blanks the personal fields.
create table contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text,
  first_name text,
  last_name text,
  job_title text,
  linkedin_url text,
  phone text,
  company_name text,
  company_domain text,
  company_size int,
  country text,
  source text not null check (source in ('import','provider','reply')),
  source_detail text,
  email_status text not null default 'unknown'
    check (email_status in ('unknown','valid','risky','invalid')),
  email_checked_at timestamptz,
  unsubscribed_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_unless_erased check (email is not null or erased_at is not null)
);
create unique index contacts_one_per_email on contacts (org_id, lower(email)) where email is not null;
create index on contacts (org_id, company_domain);

-- Cached summary of a prospect's public site, so 20 leads at one company cost one read.
create table company_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  domain text not null,
  summary text not null default '',
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, domain)
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  stage text not null default 'review'
    check (stage in ('review','excluded','active','finished','replied','bounced','stopped')),
  fit_reason text,
  client_ref text,
  status_id uuid references lead_statuses(id) on delete set null,
  note text,
  note_updated_at timestamptz,
  note_updated_by uuid references users(id) on delete set null,
  needs_reply boolean not null default false,
  why_hot text,
  became_hot_at timestamptz,
  last_message_at timestamptz,
  next_touch_at timestamptz,
  touches_sent int not null default 0,
  unsubscribe_token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index on leads (org_id);
create index on leads (contact_id);
create index on leads (status_id);
create index on leads (note_updated_by);
create index on leads (campaign_id, stage);
create index on leads (campaign_id, needs_reply, last_message_at desc);
create index on leads (org_id, became_hot_at desc) where became_hot_at is not null;
create index on leads (next_touch_at) where stage = 'active' and next_touch_at is not null;

create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  mailbox_id uuid references mailboxes(id) on delete set null,
  direction text not null check (direction in ('outbound','inbound')),
  kind text not null
    check (kind in ('first','followup','manual_reply','auto_reply','reply','auto_response','bounce')),
  touch int,
  status text not null
    check (status in ('draft','queued','sending','sent','unknown','failed','cancelled','received')),
  status_reason text,
  subject text,
  body_text text,
  from_email text,
  to_email text,
  rfc_message_id text,
  in_reply_to text,
  references_header text,
  intent text
    check (intent in ('interested','meeting_request','question','referral','not_now',
                      'not_interested','unsubscribe','other')),
  intent_confidence numeric(3,2) check (intent_confidence between 0 and 1),
  send_after timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  received_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint touch_on_sequence_mail
    check ((kind in ('first','followup')) = (touch is not null))
);
create index on messages (org_id);
create index on messages (lead_id, created_at);
create index on messages (mailbox_id, sent_at);
create index on messages (status, send_after) where status = 'queued';
create index on messages (claimed_at) where status = 'sending';
create unique index messages_one_per_touch on messages (lead_id, touch)
  where touch is not null and status <> 'cancelled';
create unique index messages_rfc_id on messages (org_id, rfc_message_id)
  where rfc_message_id is not null;

create table imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  name text not null,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  stage text check (stage in ('validating','verifying','deduplicating','creating_campaign','saving')),
  done int not null default 0,
  total int not null default 0,
  error text,
  source_csv text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on imports (org_id);
create index on imports (project_id);
create index on imports (campaign_id);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  import_id uuid not null references imports(id) on delete cascade,
  row_index int not null,
  contact_id uuid references contacts(id) on delete set null,
  outcome text not null check (outcome in ('imported','skipped')),
  reason text check (reason in ('missing_fields','invalid_email','duplicate_in_file',
                                'already_contacted','suppressed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_id, row_index)
);
create index on import_rows (org_id);
create index on import_rows (contact_id);

create table suppression_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

-- email_hash keeps an erased person suppressed without keeping their address.
create table suppression_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  list_id uuid not null references suppression_lists(id) on delete cascade,
  kind text not null check (kind in ('email','email_hash','domain')),
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (list_id, kind, value)
);
create index on suppression_entries (org_id, kind, value);

create table spend_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  kind text not null check (kind in ('ai','lead_data','email_verification','mailbox')),
  amount_micros bigint not null check (amount_micros >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  detail jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on spend_events (org_id);
create index on spend_events (project_id, occurred_at);
create index on spend_events (campaign_id, occurred_at);

-- Answers "why did this send?". Never stores email bodies.
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  actor text not null check (actor in ('user','agent','system')),
  action text not null,
  subject_type text not null,
  subject_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on audit_events (org_id, created_at desc);
create index on audit_events (subject_type, subject_id);
create index on audit_events (actor_user_id);

create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
  loop
    execute format(
      'create trigger touch_updated_at before update on %I
       for each row execute function set_updated_at()', t);
  end loop;
end $$;
