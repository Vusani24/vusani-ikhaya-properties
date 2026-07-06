create table if not exists app_state (
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into app_state (key, data)
values (
  'main',
  '{
    "rooms": { "pending": [], "approved": [], "taken": [], "declined": [], "removed": [] },
    "reviews": { "pending": [], "approved": [], "declined": [] },
    "reports": { "pending": [], "approved": [], "declined": [] },
    "transports": { "pending": [], "approved": [], "declined": [], "removed": [] },
    "transportRequests": { "pending": [], "contacted": [], "declined": [] },
    "receipts": [],
    "visitors": {},
    "settings": { "driveFolder": "" }
  }'::jsonb
)
on conflict (key) do nothing;
