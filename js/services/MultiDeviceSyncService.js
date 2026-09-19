/* ============================================
   QueueSync - MultiDeviceSyncService
   --------------------------------------------
   Connects MULTIPLE DEVICES to one shared orders database.

   Modes:
     - 'local' : no backend configured. Same-device tabs stay live
                 via DatabaseService (localStorage events). Other
                 devices are NOT connected.
     - 'live'  : Supabase configured (js/supabase-config.js). Every
                 order / stock change on ANY device is pushed to the
                 shared Supabase tables AND pulled back in real time,
                 so the admin "Food orders" count updates the moment
                 any device checks out.

   Setup (one-time, free Supabase project):
     1. Create a project at https://supabase.com
     2. Run supabase-schema.sql in the SQL editor (creates the
        student.* + admin.* tables, FKs and demo RLS policies).
     3. Copy js/supabase-config.example.js -> js/supabase-config.js
        and paste your project URL + anon key.
     4. Reload. The admin sync panel flips to "Live multi-device".

   Loop safety: DatabaseService.isRemoteApply() is true while remote
   rows are being merged, so the push handlers below skip them and
   no echo loop is possible. Merges dedupe by order id, so the admin
   order count never double-counts.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('MultiDeviceSyncService', [
    '$window',
    '$rootScope',
    '$timeout',
    'DatabaseService',
    function ($window, $rootScope, $timeout, DatabaseService) {

      var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

      // status.mode: 'local' | 'connecting' | 'live' | 'error'
      var status = {
        mode: 'local',
        message: 'Local demo mode — add Supabase config to link multiple devices.',
        deviceId: null,
        lastSyncAt: null,
        remoteOrderCount: 0
      };

      var client = null;
      var realtimeChannel = null;
      var started = false;

      function setStatus(mode, message) {
        status.mode = mode;
        status.message = message;
        try {
          $rootScope.$broadcast('sync:status', angular.copy(status));
        } catch (e) { /* noop */ }
      }

      function getStatus() {
        return angular.copy(status);
      }

      function getConfig() {
        try {
          var cfg = $window.QueueSyncConfig;
          if (cfg && cfg.supabaseUrl && cfg.supabaseAnonKey &&
              cfg.supabaseUrl.indexOf('YOUR-') !== 0) {
            return cfg;
          }
        } catch (e) { /* noop */ }
        return null;
      }

      // NOTE: tables live in the `student` and `admin` schemas
      // (two logical DBs, FK-linked — see supabase-schema.sql).
      // Expose both schemas in Supabase: Settings > API > Exposed schemas.
      function studentTable(name) { return client.schema('student').from(name); }
      function adminTable(name) { return client.schema('admin').from(name); }

      function loadScript(src) {
        return new Promise(function (resolve, reject) {
          try {
            if ($window.supabase && $window.supabase.createClient) {
              resolve();
              return;
            }
            var s = $window.document.createElement('script');
            s.src = src;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Could not load ' + src)); };
            $window.document.head.appendChild(s);
          } catch (e) {
            reject(e);
          }
        });
      }

      // ---------- PUSH: local -> shared DB ----------

      function pushOrders() {
        if (!client || DatabaseService.isRemoteApply()) { return; }
        try {
          var snap = DatabaseService.getOrdersForSync();
          if (!snap.orders.length) { return; }
          var payload = snap.orders.map(function (o) {
            return {
              id: o.id, student_id: o.student_id,
              origin_device: o.origin_device || status.deviceId,
              subtotal: o.subtotal, tax: o.tax, tax_label: o.tax_label,
              total: o.total, order_type: o.order_type, notes: o.notes,
              payment_method: o.payment_method, payment_detail: o.payment_detail,
              status: o.status, placed_at: o.placed_at
            };
          });
          studentTable('orders').upsert(payload, { onConflict: 'id' }).then(function (res) {
            if (res.error) { return; }
            var itemPayload = snap.items.map(function (it) {
              return {
                id: it.id, order_id: it.order_id, item_id: it.item_id,
                name: it.name, emoji: it.emoji, spec: it.spec, qty: it.qty,
                unit_price: it.unit_price, addon_total: it.addon_total,
                line_total: it.line_total
              };
            });
            if (itemPayload.length) {
              studentTable('order_items').upsert(itemPayload, { onConflict: 'id' }).then(function () {
                markSynced();
              });
            } else {
              markSynced();
            }
          });
        } catch (e) { /* offline -> will retry on next change */ }
      }

      function pushMenu() {
        if (!client || DatabaseService.isRemoteApply()) { return; }
        try {
          var payload = DatabaseService.getMenuItems().map(function (m) {
            return {
              id: m.id, name: m.name, emoji: m.emoji, base_price: m.base_price,
              stock_qty: m.stock_qty, available: m.available
            };
          });
          adminTable('menu_items').upsert(payload, { onConflict: 'id' }).then(function () {
            markSynced();
          });
        } catch (e) { /* noop */ }
      }

      // Pushes "how is the queue going?" reports. Id is deterministic
      // (qf-<queue>-<student>) so repeats overwrite, never duplicate.
      function pushFeedback() {
        if (!client || DatabaseService.isRemoteApply()) { return; }
        try {
          var rows = DatabaseService.getAllFeedback();
          if (!rows.length) { return; }
          studentTable('queue_feedback').upsert(rows, { onConflict: 'id' }).then(function () {
            markSynced();
          });
        } catch (e) { /* noop */ }
      }

      function markSynced() {
        status.lastSyncAt = new Date();
        try {
          $rootScope.$broadcast('sync:status', angular.copy(status));
        } catch (e) { /* noop */ }
      }

      // ---------- PULL: shared DB -> local (realtime) ----------

      function pullOrderById(orderId) {
        if (!client || !orderId) { return; }
        studentTable('orders').select('*').eq('id', orderId).single().then(function (res) {
          if (res.error || !res.data) { return; }
          studentTable('order_items').select('*').eq('order_id', orderId).then(function (ires) {
            var order = res.data;
            order.items = (ires.data || []).map(function (it) {
              return {
                id: it.id, order_id: it.order_id, item_id: it.item_id,
                name: it.name, emoji: it.emoji, spec: it.spec || [],
                qty: it.qty, unit_price: it.unit_price,
                addon_total: it.addon_total, line_total: it.line_total
              };
            });
            var added = DatabaseService.importOrders([order]);
            if (added > 0) { markSynced(); }
          });
        });
      }

      function initialPull() {
        if (!client) { return; }
        studentTable('orders').select('*').order('placed_at', { ascending: false }).limit(200)
          .then(function (res) {
            var rows = res.data || [];
            status.remoteOrderCount = rows.length;
            if (!rows.length) { return; }
            var ids = rows.map(function (r) { return r.id; });
            studentTable('order_items').select('*').in('order_id', ids).then(function (ires) {
              var byOrder = {};
              (ires.data || []).forEach(function (it) {
                (byOrder[it.order_id] = byOrder[it.order_id] || []).push({
                  id: it.id, order_id: it.order_id, item_id: it.item_id,
                  name: it.name, emoji: it.emoji, spec: it.spec || [],
                  qty: it.qty, unit_price: it.unit_price,
                  addon_total: it.addon_total, line_total: it.line_total
                });
              });
              rows.forEach(function (r) { r.items = byOrder[r.id] || []; });
              DatabaseService.importOrders(rows);
              markSynced();
            });
          });
        adminTable('menu_items').select('*').then(function (res) {
          if (res.data && res.data.length) {
            DatabaseService.importMenuItems(res.data);
          }
        });
        studentTable('queue_feedback').select('*').then(function (res) {
          if (res.data && res.data.length) {
            DatabaseService.importFeedback(res.data);
          }
        });
      }

      function subscribeRealtime() {
        if (!client) { return; }
        try {
          if (realtimeChannel) { client.removeChannel(realtimeChannel); }
          realtimeChannel = client
            .channel('queuesync-orders')
            .on('postgres_changes',
              { event: 'INSERT', schema: 'student', table: 'orders' },
              function (payload) {
                if (payload && payload.new && payload.new.origin_device !== status.deviceId) {
                  pullOrderById(payload.new.id);
                }
              })
            .on('postgres_changes',
              { event: 'UPDATE', schema: 'admin', table: 'menu_items' },
              function (payload) {
                if (payload && payload.new) {
                  DatabaseService.importMenuItems([payload.new]);
                  markSynced();
                }
              })
            .on('postgres_changes',
              { event: '*', schema: 'student', table: 'queue_feedback' },
              function (payload) {
                if (payload && payload.new) {
                  DatabaseService.importFeedback([payload.new]);
                  markSynced();
                }
              })
            .subscribe(function (subStatus) {
              if (subStatus === 'SUBSCRIBED') {
                setStatus('live', 'Live multi-device sync — orders and queue vibe update from every device.');
              }
            });
        } catch (e) {
          setStatus('error', 'Realtime subscription failed. Orders still sync on refresh.');
        }
      }

      // ---------- LIFECYCLE ----------

      function start() {
        if (started) { return; }
        started = true;
        try {
          status.deviceId = DatabaseService.getDeviceId();
        } catch (e) {
          status.deviceId = 'Device-LOCAL';
        }

        var cfg = getConfig();
        if (!cfg) {
          setStatus('local', 'Local demo mode — add Supabase config to link multiple devices.');
          return;
        }

        setStatus('connecting', 'Connecting to shared orders database…');
        loadScript(SUPABASE_CDN).then(function () {
          try {
            client = $window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
          } catch (e) {
            setStatus('error', 'Could not create Supabase client. Check URL / anon key.');
            return;
          }
          // Push local changes out (skip remote echoes via isRemoteApply).
          DatabaseService.subscribe('orders', function () { pushOrders(); });
          DatabaseService.subscribe('menu_items', function () { pushMenu(); });
          DatabaseService.subscribe('queue_feedback', function () { pushFeedback(); });
          initialPull();
          subscribeRealtime();
          // Safety net: re-push + refresh counts every 30s while live.
          (function heartbeat() {
            $timeout(function () {
              if (status.mode === 'live' || status.mode === 'connecting') {
                pushOrders();
              }
              heartbeat();
            }, 30000);
          })();
        }).catch(function () {
          setStatus('error', 'Could not reach Supabase (offline?). Running on local data.');
        });
      }

      function retry() {
        started = false;
        if (realtimeChannel && client) {
          try { client.removeChannel(realtimeChannel); } catch (e) { /* noop */ }
          realtimeChannel = null;
        }
        client = null;
        start();
      }

      // Auto-start on load so both student checkouts and the admin
      // dashboard join the shared DB without any extra clicks.
      try {
        start();
      } catch (e) { /* noop */ }

      return {
        getStatus: getStatus,
        retry: retry,
        getDeviceId: function () { return status.deviceId; }
      };
    }
  ]);

})();
