# code_blooded
A real-time queue tracker that shows live wait times so students never stand in line blind.

## Admin "Now Serving" flow (Canteen + Photostat)

Staff log in with the admin code (ADMIN@2026) on the login page and open Admin Dashboard. Two
**Now Serving** cards at the top show the FIRST request in each queue (FIFO by `joinedAt`).
The cards update live via local broadcasts (`QueueService` -> `db:changed`) - no page refresh;
positions and wait times on student pages recalculate instantly because they read the same live
member list.

### Actions
- Canteen - **Mark as Served**: quick confirm, then pops the current request off the queue.
  The student's device immediately shows the "reached the counter" flow (they then order at Counter 1).
  The next member becomes "Now Serving".
- Photostat - **Print**: opens a print-ready layout for the current job in a new tab and calls
  `window.print()`. Printing alone never deletes the request.
- Photostat - **Serve / Done**: confirms the job is finished and pops the queue entry. The next job
  becomes current.

Both button sets disable while an action runs (prevents double-serve), show success/error toasts,
catch errors, and handle the already-served case gracefully (info toast, queue advances).

## Local data model

The app runs fully locally (sessionStorage-backed demo store managed by `DatabaseService`):

```
orders          { id, student_id, subtotal, tax, total, order_type, payment_detail, status, placed_at }
order_items     { id, order_id, item_id, name, emoji, spec, qty, unit_price, addon_total, line_total }
menu_items      { id, category, name, emoji, price, options, stock_qty, available }
cart_lines      { id, cart_id, item_id, config, qty }
queue_members   { id, queue_id, student_id }        (mirror for admin)
feedback        { id, queue_id, student_id, status: 'fast'|'normal'|'slow', at }
```

- A queue request = ONE entry in the in-memory FIFO list (mirrored to `queue_members`).
  "Now Serving" = `members[0]` ordered by `joinedAt`.
- Canteen order items are NOT embedded in the member entry: in this app students place food orders AT
  the counter AFTER being served (existing flow). The canteen card therefore shows the student's most
  recent order pulled from the orders store when available, and "Waiting to place their order" before
  that.
- Photostat file uploads are captured as metadata (name/size) on the job payload shown to the admin.
  Actual file streaming/print requires a future upload backend; until then the print view shows the
  job summary plus file names.

## Role gating
Staff sign in with a client-side code (`AuthService.ADMIN_CODE`). `AdminController` gates the whole
dashboard + actions on `isAdmin()`.

## Test it (3 dummy requests, serve one by one)
1. Open two tabs/windows (Tab A = student, Tab B = staff), or two devices on the same network.
2. Tab A: log in as student `12323`, join the Canteen queue.
3. Open a second student window - log in as `12424`, join Canteen; then `12525` joins too.
   Admin (Tab B, ADMIN@2026) shows "Canteen queue 3" and Now Serving = `12323`.
4. On Tab B tap **Mark as Served** for the canteen card: `12323` disappears, `12424` becomes Now
   Serving, count drops to 2. In the student windows `12424` and `12525` move up to #1/#2 and wait
   times shrink - instantly, no refresh. `12323` sees the "reached the counter" toast.
5. Photostat: in a student window choose Print, 2 pages, 3 copies, Colour, Double-sided, attach a file,
   pay + join. Admin's Photostat card shows the job (pages, copies, ink, sides, file name, amount) and
   the two buttons. **Print** opens the print view (entry stays). **Serve / Done** removes it and the
   next student/job advances in both admin and student views.