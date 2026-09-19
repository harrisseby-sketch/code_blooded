-- ============================================
-- QueueSync - Supabase schema (optional live backend)
-- --------------------------------------------
-- The in-app DatabaseService (js/services/DatabaseService.js)
-- mirrors these exact tables, so you can swap the localStorage
-- backend for Supabase without changing controllers.
--
-- Two logical databases, linked by foreign key, as requested:
--   student schema : students, carts, cart_lines, orders,
--                    order_items, queue_members, photostat_jobs
--   admin schema   : menu_items (stock/qty), inventory_log
-- FK links across schemas:
--   cart_lines.item_id  -> admin.menu_items.id
--   order_items.item_id -> admin.menu_items.id
--   order_items.order_id -> student.orders.id
--   orders.student_id    -> student.students.id
--
-- In Supabase, schemas map to the same Postgres DB; use RLS
-- policies so students write only their own rows and admins
-- manage menu_items. Enable Realtime on orders, order_items,
-- menu_items and queue_members for live admin updates.
-- ============================================

create schema if not exists student;
create schema if not exists admin;

-- ---------- ADMIN DB ----------
create table if not exists admin.menu_items (
  id text primary key,
  name text not null,
  emoji text not null default '',
  base_price integer not null default 0,
  stock_qty integer not null default 50 check (stock_qty >= 0),
  available boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists admin.inventory_log (
  id text primary key,
  item_id text not null references admin.menu_items(id) on delete cascade,
  delta integer not null,
  reason text not null,            -- 'checkout' | 'admin_set'
  order_id text,                   -- FK-ish -> student.orders.id (nullable)
  at timestamptz not null default now()
);

-- ---------- STUDENT DB ----------
create table if not exists student.students (
  id text primary key,             -- the 5-digit student ID
  created_at timestamptz not null default now()
);

create table if not exists student.carts (
  id text primary key,
  student_id text not null references student.students(id) on delete cascade,
  status text not null default 'open' check (status in ('open','checked_out')),
  updated_at timestamptz not null default now()
);
create index if not exists carts_student_idx on student.carts(student_id, status);

create table if not exists student.cart_lines (
  id text primary key,
  cart_id text not null references student.carts(id) on delete cascade,
  item_id text not null references admin.menu_items(id),
  config jsonb not null default '{}',
  qty integer not null default 1 check (qty between 1 and 10)
);
create index if not exists cart_lines_cart_idx on student.cart_lines(cart_id);

create table if not exists student.orders (
  id text primary key,             -- orderNo, e.g. FD-XXXXX-n
  student_id text not null references student.students(id) on delete cascade,
  subtotal integer not null default 0,
  tax integer not null default 0,
  tax_label text not null default 'GST (5%)',
  total integer not null default 0,
  order_type text not null default 'takeaway',
  notes text not null default '',
  payment_method text not null default 'online',
  payment_detail text not null default '',
  status text not null default 'Placed',
  placed_at timestamptz not null default now()
);
create index if not exists orders_student_idx on student.orders(student_id, placed_at desc);

create table if not exists student.order_items (
  id text primary key,
  order_id text not null references student.orders(id) on delete cascade,
  item_id text not null references admin.menu_items(id),
  name text not null,
  emoji text not null default '',
  spec jsonb not null default '[]',
  qty integer not null check (qty >= 1),
  unit_price integer not null default 0,
  addon_total integer not null default 0,
  line_total integer not null default 0
);
create index if not exists order_items_order_idx on student.order_items(order_id);

create table if not exists student.queue_members (
  id text primary key,
  queue_id text not null,          -- 'canteen' | 'photostat'
  student_id text not null references student.students(id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index if not exists queue_members_queue_idx on student.queue_members(queue_id);

create table if not exists student.photostat_jobs (
  id text primary key,
  student_id text not null references student.students(id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------- SEED MENU (admin DB) ----------
insert into admin.menu_items (id, name, emoji, base_price, stock_qty, available) values
  ('biriyani', 'Biriyani', '🍛', 120, 50, true),
  ('alfam',    'Alfam',    '🍜',  90, 50, true),
  ('meals',    'Meals',    '🍱',  70, 50, true),
  ('chapathi', 'Chapathi', '🫓',  15, 100, true)
on conflict (id) do nothing;

-- ---------- ATOMIC CHECKOUT (all lines, stock decrement) ----------
-- Call via rpc('checkout_cart', ...) from the student app instead of
-- multiple writes, so 9 items in -> 9 order_items out, guaranteed.
create or replace function public.checkout_cart(
  p_student_id text,
  p_cart_id text,
  p_order_id text,
  p_order_type text default 'takeaway',
  p_notes text default '',
  p_payment_method text default 'online',
  p_payment_detail text default ''
) returns text
language plpgsql as $$
declare
  v_subtotal int := 0;
  v_tax int := 0;
  r record;
begin
  -- totals computed from the cart lines joined to live prices
  select coalesce(sum((m.base_price * l.qty)), 0) into v_subtotal
  from student.cart_lines l
  join admin.menu_items m on m.id = l.item_id
  where l.cart_id = p_cart_id;
  -- NOTE: per-line radio/addon deltas live in l.config; the JS client
  -- passes exact line totals — this function trusts l.qty x base here
  -- for the demo; extend with config pricing if needed.

  if v_subtotal = 0 then
    raise exception 'cart is empty';
  end if;
  v_tax := round(v_subtotal * 0.05);

  insert into student.orders (id, student_id, subtotal, tax, total, order_type, notes, payment_method, payment_detail, status)
  values (p_order_id, p_student_id, v_subtotal, v_tax, v_subtotal + v_tax, p_order_type, p_notes, p_payment_method, p_payment_detail, 'Placed');

  for r in select * from student.cart_lines where cart_id = p_cart_id loop
    insert into student.order_items (id, order_id, item_id, name, emoji, spec, qty, unit_price, addon_total, line_total)
    select 'oi-' || p_order_id || '-' || r.id, p_order_id, r.item_id, m.name, m.emoji, '[]'::jsonb,
           r.qty, m.base_price, 0, m.base_price * r.qty
    from admin.menu_items m where m.id = r.item_id;

    update admin.menu_items
       set stock_qty = greatest(0, stock_qty - r.qty),
           available = case when greatest(0, stock_qty - r.qty) = 0 then false else available end,
           updated_at = now()
     where id = r.item_id;

    insert into admin.inventory_log (id, item_id, delta, reason, order_id)
    values ('log-' || p_order_id || '-' || r.id, r.item_id, -r.qty, 'checkout', p_order_id);
  end loop;

  delete from student.cart_lines where cart_id = p_cart_id;
  update student.carts set status = 'checked_out', updated_at = now() where id = p_cart_id;

  return p_order_id;
end;
$$;

-- ---------- REALTIME (run in Supabase dashboard > Database > Replication) ----------
-- alter publication supabase_realtime add table
--   admin.menu_items, student.orders, student.order_items, student.queue_members;
