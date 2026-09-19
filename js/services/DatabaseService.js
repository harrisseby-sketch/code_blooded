/* ============================================
   QueueSync - DatabaseService (Virtual Live DB)
   --------------------------------------------
   Why this exists:
   - sessionStorage is PER TAB, so a student checkout in one tab was
     invisible (or truncated/stale) in the admin tab. That is the root
     cause of "9 items in cart, only 2 checked out / seen".
   - This service is a tiny virtual relational DB shared by student +
     admin code in THIS browser, with LIVE cross-tab sync:
       localStorage (shared) + 'storage' events + BroadcastChannel
       + $rootScope.$broadcast('db:changed', { table }).

   Logical layout (as requested: two DBs linked by foreign key):
     student_db : students, carts, cart_lines, orders, order_items,
                  queue_members, photostat_jobs
     admin_db   : menu_items (stock/qty + availability), inventory_log
   FK links:
     cart_lines.cart_id   -> carts.id
     cart_lines.item_id   -> admin_db.menu_items.id
     orders.student_id    -> students.id
     order_items.order_id -> orders.id
     order_items.item_id  -> admin_db.menu_items.id
     queue_members.student_id -> students.id

   Checkout is a single atomic transaction:
     read ALL cart_lines -> create order + order_items ->
     decrement menu_items.stock_qty -> clear cart.
     Nothing is sliced/limited, so all 9 (or N) lines checkout.

   Supabase path: the same table shapes exist in supabase-schema.sql.
   To go live, replace the localStorage backend calls in
   _persist/_load with Supabase JS calls + Realtime subscriptions;
   the public API (insert/update/query/subscribe/transaction) stays.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('DatabaseService', [
    '$window',
    '$rootScope',
    function ($window, $rootScope) {

      var LS_KEY = 'queueSync_virtualDB_v1';
      var BC_NAME = 'queuesync_db_v1';

      // ---- Seed: admin_db.menu_items (single source of truth for stock) ----
      function seedMenuItems() {
        return [
          { id: 'biriyani', name: 'Biriyani', emoji: '🍛', base_price: 120, stock_qty: 50, available: true },
          { id: 'alfam',    name: 'Alfam',    emoji: '🍜', base_price: 90,  stock_qty: 50, available: true },
          { id: 'meals',    name: 'Meals',    emoji: '🍱', base_price: 70,  stock_qty: 50, available: true },
          { id: 'chapathi', name: 'Chapathi', emoji: '🫓', base_price: 15,  stock_qty: 100, available: true }
        ];
      }

      function blankDB() {
        return {
          version: 1,
          seq: { cart: 0, cart_line: 0, order: 0, order_item: 0, queue_member: 0, job: 0, log: 0 },
          student_db: {
            students: [],       // { id (studentId), created_at }
            carts: [],          // { id, student_id, status: 'open'|'checked_out', updated_at }
            cart_lines: [],     // { id, cart_id FK, item_id FK->menu, config, qty }
            orders: [],         // { id (orderNo), student_id FK, subtotal, tax, total, order_type, payment_detail, notes, status, placed_at }
            order_items: [],    // { id, order_id FK, item_id FK, name, emoji, spec, qty, unit_price, addon_total, line_total }
            queue_members: [],  // { id, queue_id, student_id FK, joined_at }
            queue_feedback: [], // { id (qf-<queue>-<student>), queue_id, student_id FK, status fast|normal|slow, at } — one row per user per queue, latest wins
            photostat_jobs: []  // passthrough mirror of paid print jobs
          },
          admin_db: {
            menu_items: seedMenuItems(),
            inventory_log: []   // { id, item_id, delta, reason, order_id, at }
          }
        };
      }

      var db = blankDB();
      var suppressBroadcast = false;
      var channel = null;

      // ---- Multi-device identity ----
      // Each browser gets a stable device tag. Orders carry it as
      // `origin_device` so the admin dashboard can show WHICH device
      // an order came from, and the sync layer can merge rows from
      // many devices without double-counting (dedupe by order id).
      var DEVICE_KEY = 'queueSync_deviceId';
      function getDeviceId() {
        try {
          var d = $window.localStorage.getItem(DEVICE_KEY);
          if (!d) {
            d = 'Device-' + Math.random().toString(36).slice(2, 6).toUpperCase();
            $window.localStorage.setItem(DEVICE_KEY, d);
          }
          return d;
        } catch (e) {
          return 'Device-LOCAL';
        }
      }

      // Guard flag: while remote rows (another device via Supabase) are
      // being merged in, the sync layer must NOT push them back out
      // (prevents echo loops). Push handlers check isRemoteApply().
      var remoteApply = false;
      function isRemoteApply() { return remoteApply; }

      try {
        if ('BroadcastChannel' in $window) {
          channel = new $window.BroadcastChannel(BC_NAME);
          channel.onmessage = function () {
            _reloadFromStorage();
            _emit('__remote__');
          };
        }
      } catch (e) { channel = null; }

      function _load() {
        try {
          var raw = $window.localStorage.getItem(LS_KEY);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1) { db = parsed; return; }
          }
        } catch (e) { /* corrupted -> reseed below */ }
        db = blankDB();
        _persist();
      }

      function _persist() {
        try {
          $window.localStorage.setItem(LS_KEY, JSON.stringify(db));
        } catch (e) { /* quota -> ignore */ }
        if (!suppressBroadcast) {
          try {
            if (channel) { channel.postMessage({ t: Date.now() }); }
          } catch (e) { /* noop */ }
        }
      }

      function _reloadFromStorage() {
        try {
          var raw = $window.localStorage.getItem(LS_KEY);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1) { db = parsed; }
          }
        } catch (e) { /* keep current */ }
        if (!$rootScope.$$phase) { $rootScope.$applyAsync(); }
      }

      // Cross-tab live sync: another tab wrote -> reload + notify.
      angular.element($window).on('storage', function (ev) {
        try {
          if (ev && ev.key && ev.key !== LS_KEY) { return; }
        } catch (e) { /* fallthrough */ }
        _reloadFromStorage();
        _emit('__remote__');
      });

      var listeners = {}; // table -> [cb]

      function _emit(table) {
        try {
          $rootScope.$broadcast('db:changed', { table: table });
        } catch (e) { /* noop */ }
        (listeners[table] || []).slice().forEach(function (cb) {
          try { cb(table); } catch (e) { /* noop */ }
        });
        // wildcard subscribers
        (listeners['*'] || []).slice().forEach(function (cb) {
          try { cb(table); } catch (e) { /* noop */ }
        });
      }

      function _table(ns, name) {
        return db[ns][name];
      }

      function _next(seqName) {
        db.seq[seqName] = (db.seq[seqName] || 0) + 1;
        return db.seq[seqName];
      }

      // ---- FK integrity helpers ----
      function _menuItem(id) {
        var items = _table('admin_db', 'menu_items');
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === id) { return items[i]; }
        }
        return null;
      }

      function _ensureStudent(studentId) {
        var arr = _table('student_db', 'students');
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].id === studentId) { return arr[i]; }
        }
        var row = { id: studentId, created_at: new Date().toISOString() };
        arr.push(row);
        return row;
      }

      function _openCart(studentId) {
        _ensureStudent(studentId);
        var carts = _table('student_db', 'carts');
        for (var i = carts.length - 1; i >= 0; i--) {
          if (carts[i].student_id === studentId && carts[i].status === 'open') {
            return carts[i];
          }
        }
        var cart = {
          id: 'cart-' + studentId + '-' + _next('cart'),
          student_id: studentId, // FK -> students.id
          status: 'open',
          updated_at: new Date().toISOString()
        };
        carts.push(cart);
        return cart;
      }

      // ================= PUBLIC API =================

      function subscribe(table, cb) {
        if (!listeners[table]) { listeners[table] = []; }
        listeners[table].push(cb);
        return function unsubscribe() {
          var arr = listeners[table] || [];
          var idx = arr.indexOf(cb);
          if (idx > -1) { arr.splice(idx, 1); }
        };
      }

      // ---- admin_db.menu_items ----
      function getMenuItems() {
        _load();
        return angular.copy(_table('admin_db', 'menu_items'));
      }

      function getStock(itemId) {
        _load();
        var m = _menuItem(itemId);
        return m ? m.stock_qty : 0;
      }

      // Admin live control: restock / mark sold-out. Broadcasts live.
      function setMenuAvailability(itemId, available) {
        _load();
        var m = _menuItem(itemId);
        if (!m) { return null; }
        m.available = !!available;
        _persist(); _emit('menu_items');
        return angular.copy(m);
      }

      function setStock(itemId, qty) {
        _load();
        var m = _menuItem(itemId);
        if (!m) { return null; }
        var q = Math.max(0, parseInt(qty, 10) || 0);
        var delta = q - m.stock_qty;
        m.stock_qty = q;
        if (m.stock_qty === 0) { m.available = false; }
        if (m.stock_qty > 0 && !m.available && delta > 0) { m.available = true; }
        _table('admin_db', 'inventory_log').push({
          id: 'log-' + _next('log'), item_id: itemId, delta: delta,
          reason: 'admin_set', order_id: null, at: new Date().toISOString()
        });
        _persist(); _emit('menu_items');
        return angular.copy(m);
      }

      // ---- student_db carts / cart_lines ----
      // FIX (9->2 bug): every line is stored as its own row with a unique id;
      // checkout reads ALL rows for the open cart with no limit/slice.
      function addCartLine(studentId, itemId, config, qty) {
        _load();
        if (!_menuItem(itemId)) { throw new Error('Unknown menu item: ' + itemId); }
        var cart = _openCart(studentId);
        var line = {
          id: 'line-' + _next('cart_line'),
          cart_id: cart.id,          // FK -> carts.id
          item_id: itemId,           // FK -> admin_db.menu_items.id
          config: angular.copy(config || {}),
          qty: Math.max(1, Math.min(10, qty || 1))
        };
        _table('student_db', 'cart_lines').push(line);
        cart.updated_at = new Date().toISOString();
        _persist(); _emit('cart_lines'); _emit('carts');
        return angular.copy(line);
      }

      function updateCartLine(studentId, lineId, config, qty) {
        _load();
        var lines = _table('student_db', 'cart_lines');
        var cart = _openCart(studentId);
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].id === lineId && lines[i].cart_id === cart.id) {
            lines[i].config = angular.copy(config || {});
            lines[i].qty = Math.max(1, Math.min(10, qty || 1));
            cart.updated_at = new Date().toISOString();
            _persist(); _emit('cart_lines');
            return angular.copy(lines[i]);
          }
        }
        return null;
      }

      function removeCartLine(studentId, lineId) {
        _load();
        var lines = _table('student_db', 'cart_lines');
        var cart = _openCart(studentId);
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].id === lineId && lines[i].cart_id === cart.id) {
            lines.splice(i, 1);
            cart.updated_at = new Date().toISOString();
            _persist(); _emit('cart_lines');
            return true;
          }
        }
        return false;
      }

      function clearCart(studentId) {
        _load();
        var cart = _openCart(studentId);
        var lines = _table('student_db', 'cart_lines');
        for (var i = lines.length - 1; i >= 0; i--) {
          if (lines[i].cart_id === cart.id) { lines.splice(i, 1); }
        }
        cart.updated_at = new Date().toISOString();
        _persist(); _emit('cart_lines');
      }

      function getCartLines(studentId) {
        _load();
        var cart = _openCart(studentId);
        return angular.copy(_table('student_db', 'cart_lines').filter(function (l) {
          return l.cart_id === cart.id;
        }));
      }

      // ---- Atomic checkout: ALL lines -> order + items + stock decrement ----
      function checkout(studentId, orderMeta, priceFn) {
        // priceFn(lineView { itemId, config, qty }) -> { name, emoji, spec, unitPrice, addonTotal, lineTotal }
        _load();
        suppressBroadcast = true;
        try {
          var cart = _openCart(studentId);
          var lines = _table('student_db', 'cart_lines').filter(function (l) {
            return l.cart_id === cart.id;
          });
          if (!lines.length) { return null; }

          var orderNo = 'FD-' + Math.floor(10000 + Math.random() * 90000) + '-' + _next('order');
          var subtotal = 0;
          var items = lines.map(function (l) {
            var p = priceFn({ itemId: l.item_id, config: l.config, qty: l.qty });
            subtotal += p.lineTotal;
            return {
              id: 'oi-' + _next('order_item'),
              order_id: orderNo,      // FK -> orders.id
              item_id: l.item_id,     // FK -> admin_db.menu_items.id
              name: p.name, emoji: p.emoji, spec: p.spec,
              qty: l.qty, unit_price: p.unitPrice,
              addon_total: p.addonTotal, line_total: p.lineTotal
            };
          });
          var tax = Math.round(subtotal * 0.05);
          var order = {
            id: orderNo,
            student_id: studentId,    // FK -> students.id
            origin_device: getDeviceId(),
            subtotal: subtotal, tax: tax, tax_label: 'GST (5%)',
            total: subtotal + tax,
            order_type: orderMeta.orderType, notes: orderMeta.notes || '',
            payment_method: orderMeta.paymentMethod,
            payment_detail: orderMeta.paymentDetail || '',
            status: 'Placed',
            placed_at: new Date().toISOString()
          };
          _table('student_db', 'orders').push(order);
          items.forEach(function (it) { _table('student_db', 'order_items').push(it); });

          // Live inventory decrement (admin sees quantity reduce instantly).
          items.forEach(function (it) {
            var m = _menuItem(it.item_id);
            if (m) {
              m.stock_qty = Math.max(0, m.stock_qty - it.qty);
              if (m.stock_qty === 0) { m.available = false; }
              _table('admin_db', 'inventory_log').push({
                id: 'log-' + _next('log'), item_id: it.item_id,
                delta: -it.qty, reason: 'checkout', order_id: orderNo,
                at: new Date().toISOString()
              });
            }
          });

          // Clear the checked-out cart (all rows) and close it.
          var all = _table('student_db', 'cart_lines');
          for (var i = all.length - 1; i >= 0; i--) {
            if (all[i].cart_id === cart.id) { all.splice(i, 1); }
          }
          cart.status = 'checked_out';
          cart.updated_at = new Date().toISOString();
          _persist();
          return { order: angular.copy(order), items: angular.copy(items) };
        } finally {
          suppressBroadcast = false;
          _emit('orders'); _emit('order_items'); _emit('menu_items');
          _emit('cart_lines'); _emit('carts');
          try {
            if (channel) { channel.postMessage({ t: Date.now() }); }
          } catch (e) { /* noop */ }
        }
      }

      function getAllOrders() {
        _load();
        var orders = angular.copy(_table('student_db', 'orders'));
        var items = _table('student_db', 'order_items');
        // Dedupe by order id: the same order can arrive twice (local +
        // remote merge from another device) — the admin count must not
        // double-count it.
        var seen = {};
        orders = orders.filter(function (o) {
          if (seen[o.id]) { return false; }
          seen[o.id] = true;
          return true;
        });
        orders.forEach(function (o) {
          o.items = items.filter(function (it) { return it.order_id === o.id; }).map(function (it) {
            return {
              itemId: it.item_id, name: it.name, emoji: it.emoji,
              spec: it.spec, qty: it.qty, unitPrice: it.unit_price,
              addonTotal: it.addon_total, lineTotal: it.line_total
            };
          });
          o.orderNo = o.id; o._studentId = o.student_id; o.placedAt = o.placed_at;
          o.total = o.total; o.paymentDetail = o.payment_detail;
          o.orderType = o.order_type; o.status = o.status;
          o.originDevice = o.origin_device || null;
        });
        orders.sort(function (a, b) { return new Date(b.placed_at) - new Date(a.placed_at); });
        return orders;
      }

      function getLastOrder(studentId) {
        _load();
        var mine = _table('student_db', 'orders').filter(function (o) { return o.student_id === studentId; });
        if (!mine.length) { return null; }
        mine.sort(function (a, b) { return new Date(b.placed_at) - new Date(a.placed_at); });
        var all = getAllOrders();
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === mine[0].id) { return all[i]; }
        }
        return null;
      }

      // ---- queue_members mirror (live admin queue view) ----
      function syncQueueMembers(queueId, memberStudentIds) {
        _load();
        var tbl = _table('student_db', 'queue_members');
        for (var i = tbl.length - 1; i >= 0; i--) {
          if (tbl[i].queue_id === queueId) { tbl.splice(i, 1); }
        }
        (memberStudentIds || []).forEach(function (sid) {
          if (!sid || sid.indexOf('@sim-') === 0) { return; } // no bots, ever
          _ensureStudent(sid);
          tbl.push({
            id: 'qm-' + _next('queue_member'),
            queue_id: queueId, student_id: sid, // FK -> students.id
            joined_at: new Date().toISOString()
          });
        });
        _persist(); _emit('queue_members');
      }

      function getQueueMembers(queueId) {
        _load();
        return angular.copy(_table('student_db', 'queue_members').filter(function (m) {
          // Defensive: pre-bot-removal DBs may hold '@sim-…' rows.
          return m.queue_id === queueId && m.student_id && m.student_id.indexOf('@sim-') !== 0;
        }));
      }

      // ---- queue_feedback: "how is the queue going?" from REAL users ----
      // One row per (queue, student) — id is deterministic so repeats from
      // any device overwrite instead of duplicating (latest wins).
      function feedbackId(queueId, studentId) {
        return 'qf-' + queueId + '-' + studentId;
      }

      function saveFeedback(queueId, studentId, statusValue) {
        if (['fast', 'normal', 'slow'].indexOf(statusValue) === -1) { return null; }
        _load();
        _ensureStudent(studentId);
        var tbl = _table('student_db', 'queue_feedback');
        var id = feedbackId(queueId, studentId);
        var now = new Date().toISOString();
        for (var i = 0; i < tbl.length; i++) {
          if (tbl[i].id === id) {
            tbl[i].status = statusValue;
            tbl[i].at = now;
            _persist(); _emit('queue_feedback');
            return angular.copy(tbl[i]);
          }
        }
        var row = { id: id, queue_id: queueId, student_id: studentId, status: statusValue, at: now };
        tbl.push(row);
        _persist(); _emit('queue_feedback');
        return angular.copy(row);
      }

      function getFeedback(queueId) {
        _load();
        return angular.copy(_table('student_db', 'queue_feedback').filter(function (f) {
          return f.queue_id === queueId;
        }));
      }

      function getAllFeedback() {
        _load();
        return angular.copy(_table('student_db', 'queue_feedback'));
      }

      // Merges feedback rows from other devices. Latest `at` wins per id.
      function importFeedback(remoteRows) {
        if (!remoteRows || !remoteRows.length) { return 0; }
        _load();
        remoteApply = true;
        var changed = 0;
        try {
          var tbl = _table('student_db', 'queue_feedback');
          var byId = {};
          tbl.forEach(function (f) { byId[f.id] = f; });
          remoteRows.forEach(function (rf) {
            if (!rf || !rf.id || !rf.queue_id || !rf.student_id) { return; }
            if (['fast', 'normal', 'slow'].indexOf(rf.status) === -1) { return; }
            _ensureStudent(rf.student_id);
            var cur = byId[rf.id];
            var remoteAt = new Date(rf.at).getTime();
            var curAt = cur ? new Date(cur.at).getTime() : NaN;
            if (!cur || (!isNaN(remoteAt) && remoteAt > curAt)) {
              var row = {
                id: rf.id, queue_id: rf.queue_id, student_id: rf.student_id,
                status: rf.status, at: rf.at || new Date().toISOString()
              };
              if (cur) {
                for (var k in row) { cur[k] = row[k]; }
              } else {
                tbl.push(row);
                byId[rf.id] = row;
              }
              changed++;
            }
          });
          _persist();
        } finally {
          remoteApply = false;
        }
        if (changed > 0) { _emit('queue_feedback'); }
        return changed;
      }

      // ---- photostat_jobs mirror ----
      function savePhotostatJob(job) {
        _load();
        _ensureStudent(job.student_id);
        var tbl = _table('student_db', 'photostat_jobs');
        tbl.push(angular.extend({ id: 'job-' + _next('job') }, angular.copy(job)));
        _persist(); _emit('photostat_jobs');
      }

      function getAllPhotostatJobs() {
        _load();
        return angular.copy(_table('student_db', 'photostat_jobs'));
      }

      // ---- Multi-device merge (called by MultiDeviceSyncService) ----
      // Merges order rows received from OTHER devices into the local DB.
      // Expected shape per order (Supabase row shape):
      //   { id, student_id, origin_device, subtotal, tax, tax_label, total,
      //     order_type, notes, payment_method, payment_detail, status,
      //     placed_at, items: [{ id, order_id, item_id, name, emoji, spec,
      //     qty, unit_price, addon_total, line_total }] }
      // Returns the number of NEW orders merged (0 = all duplicates).
      function importOrders(remoteOrders) {
        if (!remoteOrders || !remoteOrders.length) { return 0; }
        _load();
        remoteApply = true;
        var added = 0;
        try {
          var orders = _table('student_db', 'orders');
          var items = _table('student_db', 'order_items');
          var haveOrder = {};
          orders.forEach(function (o) { haveOrder[o.id] = true; });
          var haveItem = {};
          items.forEach(function (it) { haveItem[it.id] = true; });
          remoteOrders.forEach(function (ro) {
            if (!ro || !ro.id || haveOrder[ro.id]) { return; }
            _ensureStudent(ro.student_id || 'unknown');
            orders.push({
              id: ro.id,
              student_id: ro.student_id || 'unknown',
              origin_device: ro.origin_device || 'remote',
              subtotal: ro.subtotal || 0, tax: ro.tax || 0,
              tax_label: ro.tax_label || 'GST (5%)', total: ro.total || 0,
              order_type: ro.order_type || 'takeaway', notes: ro.notes || '',
              payment_method: ro.payment_method || 'online',
              payment_detail: ro.payment_detail || '',
              status: ro.status || 'Placed',
              placed_at: ro.placed_at || new Date().toISOString()
            });
            haveOrder[ro.id] = true;
            added++;
            (ro.items || []).forEach(function (ri) {
              if (!ri || !ri.id || haveItem[ri.id]) { return; }
              items.push({
                id: ri.id, order_id: ro.id,
                item_id: ri.item_id, name: ri.name || '', emoji: ri.emoji || '',
                spec: ri.spec || [], qty: ri.qty || 1,
                unit_price: ri.unit_price || 0, addon_total: ri.addon_total || 0,
                line_total: ri.line_total || 0
              });
              haveItem[ri.id] = true;
            });
          });
          // Keep the id sequence ahead so locally generated ids never
          // collide with merged remote ones.
          db.seq.order = Math.max(db.seq.order || 0, orders.length + 1);
          db.seq.order_item = Math.max(db.seq.order_item || 0, items.length + 1);
          _persist();
        } finally {
          remoteApply = false;
        }
        if (added > 0) { _emit('orders'); _emit('order_items'); }
        return added;
      }

      // Merges menu stock rows received from other devices/admins.
      // Last-write-wins per item id.
      function importMenuItems(remoteItems) {
        if (!remoteItems || !remoteItems.length) { return 0; }
        _load();
        remoteApply = true;
        var updated = 0;
        try {
          remoteItems.forEach(function (ri) {
            if (!ri || !ri.id) { return; }
            var m = _menuItem(ri.id);
            if (!m) { return; }
            if (typeof ri.stock_qty === 'number') { m.stock_qty = Math.max(0, ri.stock_qty); }
            if (typeof ri.available === 'boolean') { m.available = ri.available; }
            if (m.stock_qty === 0) { m.available = false; }
            updated++;
          });
          _persist();
        } finally {
          remoteApply = false;
        }
        if (updated > 0) {
          _emit('menu_items');
          $rootScope.$broadcast('food:menuUpdated');
        }
        return updated;
      }

      // Raw rows for pushing local state OUT to other devices.
      function getOrdersForSync() {
        _load();
        return {
          orders: angular.copy(_table('student_db', 'orders')),
          items: angular.copy(_table('student_db', 'order_items'))
        };
      }

      // ---- maintenance ----
      function reset() {
        db = blankDB();
        _persist();
        _emit('*');
      }

      _load();

      return {
        subscribe: subscribe,
        getDeviceId: getDeviceId,
        isRemoteApply: isRemoteApply,
        getMenuItems: getMenuItems,
        getStock: getStock,
        setMenuAvailability: setMenuAvailability,
        setStock: setStock,
        addCartLine: addCartLine,
        updateCartLine: updateCartLine,
        removeCartLine: removeCartLine,
        clearCart: clearCart,
        getCartLines: getCartLines,
        checkout: checkout,
        getAllOrders: getAllOrders,
        getLastOrder: getLastOrder,
        importOrders: importOrders,
        importMenuItems: importMenuItems,
        getOrdersForSync: getOrdersForSync,
        syncQueueMembers: syncQueueMembers,
        getQueueMembers: getQueueMembers,
        saveFeedback: saveFeedback,
        getFeedback: getFeedback,
        getAllFeedback: getAllFeedback,
        importFeedback: importFeedback,
        savePhotostatJob: savePhotostatJob,
        getAllPhotostatJobs: getAllPhotostatJobs,
        reset: reset
      };
    }
  ]);

})();
