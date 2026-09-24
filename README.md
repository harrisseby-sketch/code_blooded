# code_blooded
A real-time queue tracker that shows live wait times so students never stand in line blind.

## Admin "Now Serving" flow (Canteen + Photostat)

Staff log in with the admin code (ADMIN@2026) on the login page and open Admin Dashboard. Two
**Now Serving** cards at the top show the FIRST request in each queue (FIFO by `joinedAt`).
The cards update live via Firestore `onSnapshot` - no page refresh; positions and wait times on
student pages recalculate instantly because they read the same live member list.

### Actions
- Canteen - **Mark as Served**: quick confirm, then atomically archives + deletes the member doc.
  The student's device immediately shows the "reached the counter" flow (they then order at Counter 1).
  The next member becomes "Now Serving".
- Photostat - **Print**: opens a print-ready layout for the current job in a new tab and calls
  `window.print()`. Printing alone never deletes the request.
- Photostat - **Serve / Done**: confirms the job is finished, optionally deletes any uploaded file
  from Firebase Storage first (when `request.files[].url` is a `gs://` URL), then archives + deletes
  the member doc. The next job becomes current.

Both button sets disable while an action runs (prevents double-serve / duplicate deletes), show
success/error toasts, catch + log Firestore errors, and handle the already-served case gracefully
(info toast, queue advances).

## Collections / fields assumed

```
queues/{locationId}                        { count, updatedAt }              locationId: 'canteen' | 'photostat'
queues/{locationId}/members/{studentId}    { joinedAt, updatedAt, request }
    request (photostat):                   { orderNo, serviceId, serviceLabel, pages, copies,
                                             color: 'bw'|'color', sides: 'single'|'double',
                                             files: [{ name, size, url? }], amount,
                                             paymentLabel, paidAt }
queues/{locationId}/history/{studentId}    { studentId, joinedAt, request, status: 'Served', servedAt }
                                           (written atomically by the serve transaction; use for stats)
queues/{locationId}/feedback/{studentId}   { status: 'fast'|'normal'|'slow', at }
```

- A queue request = ONE member document. "Now Serving" = `members` query 1 ordered by `joinedAt`.
- Canteen order items are NOT stored in the member doc: in this app students place food orders AT the
  counter AFTER being served (existing flow). The canteen card therefore shows the student's most
  recent order pulled from the orders store when available, and "Waiting to place their order" before
  that. If you want orders embedded in the request doc, also write the payload into
  `members/{studentId}.request` from the order flow (OrderService / FoodCheckoutController).
- Files are captured as metadata (name/size) and stored in `request.files`. No upload to Firebase
  Storage yet, so `files[].url` is optional; `Serve / Done` only calls `deleteStorageFile` for a `gs://`
  URL. To enable real document streaming/print + cleanup, upload in
  `PhotostatQueueController.onFilesSelected` and set `f.url`.

## Role gating
The app signs staff in with a client-side code (AuthService.ADMIN_CODE), so there is no Firebase Auth
session yet. `AdminController` gates the whole dashboard + actions on `isAdmin()`, and Firestore rules
are permissive at member level. Once Firebase Auth is added, tighten the delete/write rules in
`firestore.rules` with an admin token/claim.

## Firestore setup
1. Project config lives in `js/firebase-config.js` (project `dbque-c1d95`). If the Firebase SDK or the
   network is unavailable the app automatically falls back to local demo mode.
2. Publish `firestore.rules` to the project.
3. No composite index needed - `orderBy('joinedAt')` is a single-field order on the members subcollection.

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