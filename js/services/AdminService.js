/* ============================================
   QueueSync - AdminService
   The single service provider behind the admin
   dashboard. Owns the live admin state (queue
   members, menu / stock, orders, photostat jobs,
   Now Serving cards) and the admin actions
   (serve current request, print photostat job).

   Real-time: subscribes once to the app-wide
   events ('db:changed', 'food:menuUpdated',
   'queue:updated', 'sync:status') and re-derives
   the whole state, so the dashboard stays live
   with no polling. A 10s $interval refresh is
   kept only as a safety net.

   Controllers bind via onState(...) / getState().
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('AdminService', [
    '$rootScope',
    '$window',
    '$interval',
    '$q',
    'AuthService',
    'QueueService',
    'FoodOrderService',
    'DatabaseService',
    'FirestoreService',
    function ($rootScope, $window, $interval, $q, AuthService, QueueService, FoodOrderService, DatabaseService, FirestoreService) {

      /**
       * Live dashboard state. Mutated only by refresh(); every mutation is
       * announced via the 'admin:state' broadcast to bound controllers.
       */
      var state = {
        isLoading: false,
        refreshedAt: null,
        canteen: { title: 'Canteen', members: [] },
        photostat: { title: 'Photostat', members: [] },
        menu: [],
        orders: [],
        photostatJobs: [],
        stats: {
          canteenCount: 0,
          photostatCount: 0,
          orderCount: 0,
          jobCount: 0,
          studentCount: 0,
          availableItems: 0,
          soldOutItems: 0
        },
        canteenLive: { label: 'Normal', colorClass: 'status-normal', reports: 0 },
        photostatLive: { label: 'Normal', colorClass: 'status-normal', reports: 0 },
        nowServing: { canteen: null, photostat: null }
      };

      // ---- Session (delegates to AuthService) ----

      function isAdmin() {
        return AuthService.isAdmin();
      }

      function adminLogin(code) {
        return AuthService.adminLogin(code);
      }

      function adminLogout() {
        AuthService.logout();
        AuthService.adminLogout();
      }

      // ---- Data readers (orders / jobs / queue members) ----

      /**
       * Orders come from the shared DB (student_db.orders JOIN
       * student_db.order_items), so EVERY student's EVERY order with ALL
       * its items is visible — never just the current tab's last order.
       * A legacy sessionStorage scan is kept as a fallback for orders
       * placed before the shared-DB upgrade.
       */
      function readAllFoodOrders() {
        var orders = [];
        try {
          orders = DatabaseService.getAllOrders();
        } catch (e) { orders = []; }
        if (!orders.length) {
          orders = readLegacyFoodOrders();
        }
        return orders;
      }

      function readLegacyFoodOrders() {
        var orders = [];
        try {
          for (var i = 0; i < $window.sessionStorage.length; i++) {
            var key = $window.sessionStorage.key(i);
            if (key && key.indexOf('queueSync_foodOrder_') === 0) {
              var sid = key.replace('queueSync_foodOrder_', '');
              try {
                var order = JSON.parse($window.sessionStorage.getItem(key));
                if (order && order.orderNo) {
                  order._studentId = order._studentId || sid;
                  orders.push(order);
                }
              } catch (e) { /* skip corrupt entry */ }
            }
          }
        } catch (e) { /* noop */ }
        orders.sort(function (a, b) {
          return new Date(b.placedAt) - new Date(a.placedAt);
        });
        return orders;
      }

      function readAllPhotostatJobs() {
        var jobs = [];
        try {
          jobs = DatabaseService.getAllPhotostatJobs();
        } catch (e) { jobs = []; }
        try {
          for (var i = 0; i < $window.sessionStorage.length; i++) {
            var key = $window.sessionStorage.key(i);
            if (key && key.indexOf('queueSync_photostatJob_') === 0) {
              var sid = key.replace('queueSync_photostatJob_', '');
              try {
                var job = JSON.parse($window.sessionStorage.getItem(key));
                if (job && job.orderNo) {
                  job._studentId = sid;
                  jobs.push(job);
                }
              } catch (e) { /* skip corrupt entry */ }
            }
          }
        } catch (e) { /* noop */ }
        jobs.sort(function (a, b) {
          return new Date(b.paidAt || b.at) - new Date(a.paidAt || a.at);
        });
        return jobs;
      }

      /**
       * Queue members: live in-memory list first (includes simulation),
       * merged with the DB mirror so checkouts from other tabs appear.
       */
      function readQueueMembers(locationId) {
        var seen = {};
        var out = [];
        try {
          var q = QueueService.getQueue(locationId);
          (q ? q.members : []).forEach(function (m) {
            if (m && m.studentId && !seen[m.studentId]) {
              seen[m.studentId] = true;
              out.push(m);
            }
          });
        } catch (e) { /* noop */ }
        try {
          DatabaseService.getQueueMembers(locationId).forEach(function (m) {
            if (m && m.student_id && !seen[m.student_id] && m.student_id.indexOf('@sim-') !== 0) {
              seen[m.student_id] = true;
              out.push({ studentId: m.student_id, joinedAt: m.joined_at });
            }
          });
        } catch (e) { /* noop */ }
        return out;
      }

      // ---- Now Serving decoration ----

      /**
       * Decorate the first queue member for the "Now Serving" card.
       * For canteen, the most recent order (if any) is looked up so the card
       * can show items / total — orders are placed AT the counter, so the
       * member document itself carries no order payload.
       */
      function servingView(locationId) {
        var ns = QueueService.getNowServing(locationId);
        if (!ns) {
          return null;
        }
        var view = {
          studentId: ns.studentId,
          joinedAt: ns.joinedAt,
          position: ns.position,
          request: ns.request || {}
        };
        view.hasRequest = !!(ns.request && Object.keys(ns.request).length);
        if (locationId === 'canteen') {
          view.order = latestFoodOrderFor(ns.studentId);
        }
        return view;
      }

      function latestFoodOrderFor(studentId) {
        var mine = (readAllFoodOrders() || []).filter(function (o) {
          return o && o._studentId === studentId;
        });
        if (!mine.length) {
          return null;
        }
        mine.sort(function (a, b) {
          return new Date(b.placedAt || 0) - new Date(a.placedAt || 0);
        });
        return mine[0];
      }

      function liveVibe(locationId) {
        try {
          var info = QueueService.getQueueInfo(locationId);
          if (info && info.liveStatus) {
            return {
              label: info.liveStatus.label,
              colorClass: info.liveStatus.colorClass,
              reports: info.liveStatus.reports || 0
            };
          }
        } catch (e) { /* noop */ }
        return { label: 'Normal', colorClass: 'status-normal', reports: 0 };
      }

      // ---- Refresh (re-derives the whole state) ----

      function refresh() {
        state.isLoading = true;

        state.canteen.members = readQueueMembers('canteen');
        state.canteen.count = state.canteen.members.length;

        state.photostat.members = readQueueMembers('photostat');
        state.photostat.count = state.photostat.members.length;

        state.menu = FoodOrderService.getMenu();
        state.orders = readAllFoodOrders();
        state.photostatJobs = readAllPhotostatJobs();

        // Unique students seen across queues, orders and jobs.
        var studentIds = {};
        state.canteen.members.concat(state.photostat.members).forEach(function (m) {
          if (m.studentId) { studentIds[m.studentId] = true; }
        });
        state.orders.forEach(function (o) { if (o._studentId) { studentIds[o._studentId] = true; } });
        state.photostatJobs.forEach(function (j) {
          if (j._studentId) { studentIds[j._studentId] = true; }
          else if (j.student_id) { studentIds[j.student_id] = true; }
        });

        var availableItems = 0;
        var soldOutItems = 0;
        state.menu.forEach(function (item) {
          if (item.available) { availableItems++; } else { soldOutItems++; }
        });

        state.stats = {
          canteenCount: state.canteen.count,
          photostatCount: state.photostat.count,
          orderCount: state.orders.length,
          jobCount: state.photostatJobs.length,
          studentCount: Object.keys(studentIds).length,
          availableItems: availableItems,
          soldOutItems: soldOutItems
        };

        // Live queue vibe, voted by REAL users on any device.
        state.canteenLive = liveVibe('canteen');
        state.photostatLive = liveVibe('photostat');

        // First entry of each queue == the staff's current request.
        state.nowServing.canteen = servingView('canteen');
        state.nowServing.photostat = servingView('photostat');

        state.refreshedAt = new Date();
        state.isLoading = false;

        $rootScope.$broadcast('admin:state', state);
      }

      // ---- Menu / stock controls (live to students) ----

      function toggleAvailability(item) {
        try {
          DatabaseService.setMenuAvailability(item.id, !item.available);
        } catch (e) { /* noop */ }
        refresh();
      }

      function restock(item, qty) {
        var q = parseInt(qty, 10);
        if (isNaN(q) || q < 0) { return; }
        try {
          DatabaseService.setStock(item.id, q);
        } catch (e) { /* noop */ }
        refresh();
      }

      function adjustStock(item, delta) {
        try {
          var current = 0;
          state.menu.forEach(function (m) {
            if (m.id === item.id) { current = m.stockQty || 0; }
          });
          DatabaseService.setStock(item.id, Math.max(0, current + delta));
        } catch (e) { /* noop */ }
        refresh();
      }

      /**
       * Total quantity ordered for a given menu item.
       */
      function orderItemCount(itemId) {
        var count = 0;
        (state.orders || []).forEach(function (o) {
          (o.items || []).forEach(function (it) {
            if (it.itemId === itemId || it.id === itemId) { count += it.qty; }
          });
        });
        return count;
      }

      function orderTypeLabel(id) {
        var map = { takeaway: 'Takeaway', pickup: 'Pickup', 'dine-in': 'Dine-in' };
        return map[id] || id || '—';
      }

      /**
       * Formats a stored timestamp for display.
       */
      function formatTime(value) {
        var d = new Date(value);
        if (isNaN(d.getTime())) { return '—'; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
      }

      /**
       * Formats a stored date for display.
       */
      function formatDate(value) {
        var d = new Date(value);
        if (isNaN(d.getTime())) { return '—'; }
        return (d.getMonth() + 1) + '/' + d.getDate();
      }

      // ---- Admin actions ----

      /**
       * Serves the current request in `locationId`.
       * Photostat jobs clean up any stored file first (best-effort).
       * @returns {Promise<{studentId:string, request:Object|null}|null>}
       *   null means the queue was already emptied (raced serve).
       */
      function serveCurrent(locationId) {
        var ns = state.nowServing[locationId];
        if (!ns) {
          return $q.reject({ code: 'EMPTY', message: 'No pending request.' });
        }

        var fileUrls = [];
        var job = ns.request || {};
        if (locationId === 'photostat' && job.files && job.files.length) {
          // `url` is the gs:// bucket path (uploaded via FirestoreService.uploadFiles);
          // fall back to any legacy https/gs link stored on the file.
          job.files.forEach(function (f) {
            if (f && (f.storageUrl || f.url)) { fileUrls.push(f.storageUrl || f.url); }
          });
        }

        var storageCleanup = fileUrls.length
          ? $q.all(fileUrls.map(function (url) {
              return FirestoreService.deleteStorageFile(url).catch(function () { return null; });
            })).then(function () { return true; })
          : $q.resolve(true);

        return storageCleanup
          .then(function () {
            return QueueService.completeCurrent(locationId);
          });
      }

      /**
       * Opens a print-ready layout for the current photostat job in a new
       * tab and triggers window.print(). Printing alone never deletes the
       * queue entry — that only happens via serveCurrent('photostat').
       * @returns {boolean} true when the print window opened (false = blocked).
       */
      function openPrint() {
        var ns = state.nowServing.photostat;
        if (!ns) {
          return false;
        }
        var job = ns.request || {};

        var printWindow = $window.open('', '_blank');
        if (!printWindow) {
          return false;
        }

        var entries = [
          ['Job no.', job.orderNo || '—'],
          ['Student', ns.studentId],
          ['Service', job.serviceLabel || 'Print / Photostat'],
          ['Pages', job.pages != null ? job.pages : '—'],
          ['Copies', job.copies != null ? job.copies : 1],
          ['Colour', job.color === 'color' ? 'Colour' : (job.color === 'bw' ? 'B/W' : '—')],
          ['Sides', job.sides === 'double' ? 'Double-sided' : (job.sides === 'single' ? 'Single-sided' : '—')],
          ['Amount', job.amount != null ? '\u20B9' + job.amount : '—'],
          ['Payment', job.paymentLabel || '—']
        ];

        var rows = entries.map(function (pair) {
          return '<tr><th>' + htmlEsc(pair[0]) + '</th><td>' + htmlEsc(pair[1]) + '</td></tr>';
        }).join('');

        var fileHtml = '';
        if (job.files && job.files.length) {
          fileHtml = '<h3>File(s) to print</h3><ul>' +
            job.files.map(function (f) {
              return '<li>' + htmlEsc(f.name || 'file') + '</li>';
            }).join('') + '</ul>';
          // Embed the actual uploaded file(s) when a preview link exists so
          // printing the popup prints the document/image itself, not just the
          // job summary.
          job.files.forEach(function (f) {
            if (!f || !(f.previewUrl || f.url)) { return; }
            var src = htmlEsc(f.previewUrl || f.url);
            var lower = String(f.name || '').toLowerCase();
            if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) {
              fileHtml += '<div class="file-embed"><img src="' + src + '" alt="' + htmlEsc(f.name) + '"></div>';
            } else {
              fileHtml += '<div class="file-embed"><iframe src="' + src +
                '" style="width:100%;min-height:420px;border:1px solid #e2e8f0;border-radius:8px"></iframe></div>';
            }
          });
        }

        printWindow.document.write(
          '<!doctype html><html><head><meta charset="utf-8">' +
          '<title>Print ' + htmlEsc(job.orderNo || 'Job') + '</title>' +
          '<style>' +
          'body{font-family:Inter,Arial,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#0f172a}' +
          'h1{font-size:22px;margin:0 0 4px}' +
          '.muted{color:#64748b;font-size:13px;margin-bottom:16px}' +
          'table{width:100%;border-collapse:collapse}' +
          'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:14px}' +
          'th{color:#64748b;font-weight:600;width:130px}' +
          'h3{font-size:15px;margin:20px 0 6px}' +
          'ul{margin:0;padding-left:20px;font-size:14px}' +
          'li{padding:2px 0}' +
          '.file-embed{margin:10px 0;page-break-inside:avoid}' +
          '.file-embed img{width:100%;border:1px solid #e2e8f0;border-radius:8px}' +
          '</style></head><body>' +
          '<h1>Photostat Job</h1>' +
          '<div class="muted">QueueSync &middot; generated on ' + new Date().toLocaleString() + '</div>' +
          '<table>' + rows + '</table>' + fileHtml +
          '<script>window.onload=function(){window.setTimeout(function(){window.focus();window.print();},1200);};</script>' +
          '</body></html>'
        );
        printWindow.document.close();
        printWindow.focus();
        return true;
      }

      function htmlEsc(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // ---- Binding for controllers ----

      function getState() {
        return state;
      }

      function onState(cb) {
        return $rootScope.$on('admin:state', function (event, s) {
          cb(s);
        });
      }

      // ---- Live subscriptions (registered once, live for the app) ----

      $rootScope.$on('db:changed', refresh);
      $rootScope.$on('food:menuUpdated', refresh);
      $rootScope.$on('queue:updated', refresh);
      $rootScope.$on('sync:status', refresh);

      // Safety-net refresh while the dashboard is open (live events do the
      // real work; this only covers edge cases like clock/advice text).
      $interval(refresh, 10000);

      refresh();

      return {
        getState: getState,
        onState: onState,
        refresh: refresh,
        isAdmin: isAdmin,
        adminLogin: adminLogin,
        adminLogout: adminLogout,
        toggleAvailability: toggleAvailability,
        restock: restock,
        adjustStock: adjustStock,
        orderItemCount: orderItemCount,
        orderTypeLabel: orderTypeLabel,
        formatTime: formatTime,
        formatDate: formatDate,
        serveCurrent: serveCurrent,
        openPrint: openPrint
      };
    }
  ]);
})();