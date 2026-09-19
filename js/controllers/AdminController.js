/* ============================================
   QueueSync - AdminController (live DB-backed)
   Admin dashboard: live queue occupancy, food
   stock / availability, placed food orders and
   print / photostat jobs.

   LIVE UPDATES: subscribes to the virtual live DB
   (DatabaseService) instead of polling sessionStorage:
     - student checkout -> orders/order_items tables change
       -> stock_qty decrements in admin_db.menu_items
       -> this dashboard refreshes instantly (same tab via
          $rootScope event, other tabs via storage event).
     - admin restock / sold-out toggle -> menu_items change
       -> student menu updates live via 'food:menuUpdated'.
   A 10s $interval refresh is kept only as a safety net.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('AdminController', [
    '$scope',
    '$location',
    '$interval',
    '$window',
    'AuthService',
    'QueueService',
    'FoodOrderService',
    'DatabaseService',
    function ($scope, $location, $interval, $window, AuthService, QueueService, FoodOrderService, DatabaseService) {

      // Admin-only route guard
      if (!AuthService.isAdmin()) {
        $location.path('/login');
        return;
      }

      $scope.isLoading = false;
      $scope.refreshedAt = null;

      $scope.canteen = { title: 'Canteen', members: [], count: 0 };
      $scope.photostat = { title: 'Photostat', members: [], count: 0 };
      $scope.menu = [];
      $scope.orders = [];
      $scope.photostatJobs = [];
      $scope.stats = {
        canteenCount: 0,
        photostatCount: 0,
        orderCount: 0,
        jobCount: 0,
        studentCount: 0,
        availableItems: 0,
        soldOutItems: 0
      };

      /**
       * Orders come from the shared DB (student_db.orders JOIN
       * student_db.order_items), so EVERY student's EVERY order with ALL
       * its items is visible — never just the current tab's last order.
       * A legacy sessionStorage scan is kept as a fallback for orders
       * placed before this upgrade.
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
            if (m && m.student_id && !seen[m.student_id]) {
              seen[m.student_id] = true;
              out.push({ studentId: m.student_id, joinedAt: m.joined_at });
            }
          });
        } catch (e) { /* noop */ }
        return out;
      }

      /**
       * Refreshes every panel on the dashboard.
       */
      $scope.refresh = function () {
        $scope.isLoading = true;

        $scope.canteen.members = readQueueMembers('canteen');
        $scope.canteen.count = $scope.canteen.members.length;

        $scope.photostat.members = readQueueMembers('photostat');
        $scope.photostat.count = $scope.photostat.members.length;

        $scope.menu = FoodOrderService.getMenu();
        $scope.orders = readAllFoodOrders();
        $scope.photostatJobs = readAllPhotostatJobs();

        // Unique students seen across queues, orders and jobs.
        var studentIds = {};
        $scope.canteen.members.concat($scope.photostat.members).forEach(function (m) {
          if (m.studentId) { studentIds[m.studentId] = true; }
        });
        $scope.orders.forEach(function (o) { if (o._studentId) { studentIds[o._studentId] = true; } });
        $scope.photostatJobs.forEach(function (j) {
          if (j._studentId) { studentIds[j._studentId] = true; }
          else if (j.student_id) { studentIds[j.student_id] = true; }
        });

        var availableItems = 0;
        var soldOutItems = 0;
        $scope.menu.forEach(function (item) {
          if (item.available) { availableItems++; } else { soldOutItems++; }
        });

        $scope.stats = {
          canteenCount: $scope.canteen.count,
          photostatCount: $scope.photostat.count,
          orderCount: $scope.orders.length,
          jobCount: $scope.photostatJobs.length,
          studentCount: Object.keys(studentIds).length,
          availableItems: availableItems,
          soldOutItems: soldOutItems
        };

        $scope.refreshedAt = new Date();
        $scope.isLoading = false;
      };

      $scope.refresh();

      // ---- Live subscriptions: no manual refresh needed ----
      var unbindDb = $scope.$on('db:changed', function () {
        $scope.refresh();
      });
      var unbindMenu = $scope.$on('food:menuUpdated', function () {
        $scope.refresh();
      });

      // ---- Admin stock / availability controls (live to students) ----
      $scope.toggleAvailability = function (item) {
        try {
          DatabaseService.setMenuAvailability(item.id, !item.available);
        } catch (e) { /* noop */ }
        $scope.refresh();
      };

      $scope.restock = function (item, qty) {
        var q = parseInt(qty, 10);
        if (isNaN(q) || q < 0) { return; }
        try {
          DatabaseService.setStock(item.id, q);
        } catch (e) { /* noop */ }
        $scope.refresh();
      };

      $scope.adjustStock = function (item, delta) {
        try {
          var current = 0;
          $scope.menu.forEach(function (m) {
            if (m.id === item.id) { current = m.stockQty || 0; }
          });
          DatabaseService.setStock(item.id, Math.max(0, current + delta));
        } catch (e) { /* noop */ }
        $scope.refresh();
      };

      /**
       * Total quantity ordered for a given menu item.
       */
      $scope.orderItemCount = function (itemId) {
        var count = 0;
        ($scope.orders || []).forEach(function (o) {
          (o.items || []).forEach(function (it) {
            if (it.itemId === itemId || it.id === itemId) { count += it.qty; }
          });
        });
        return count;
      };

      $scope.orderTypeLabel = function (id) {
        var map = { takeaway: 'Takeaway', pickup: 'Pickup', 'dine-in': 'Dine-in' };
        return map[id] || id || '—';
      };

      /**
       * Formats a stored timestamp for display.
       */
      $scope.formatTime = function (value) {
        var d = new Date(value);
        if (isNaN(d.getTime())) { return '—'; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
      };

      /**
       * Formats a stored date for display.
       */
      $scope.formatDate = function (value) {
        var d = new Date(value);
        if (isNaN(d.getTime())) { return '—'; }
        return (d.getMonth() + 1) + '/' + d.getDate();
      };

      /**
       * Admin logout - clears both the admin and any leftover student session
       * so the logout always returns to the clean login page.
       */
      $scope.logoutAdmin = function () {
        AuthService.logout();
        AuthService.adminLogout();
        $location.path('/login');
      };

      // Safety-net refresh while the dashboard is open (live events do the
      // real work; this only covers edge cases like clock/advice text).
      var interval = $interval($scope.refresh, 10000);

      $scope.$on('$destroy', function () {
        if (interval) { $interval.cancel(interval); }
        if (unbindDb) { unbindDb(); }
        if (unbindMenu) { unbindMenu(); }
      });
    }
  ]);

})();
