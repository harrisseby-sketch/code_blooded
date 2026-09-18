/* ============================================
   QueueSync - AdminController
   Admin dashboard: live queue occupancy, food
   availability, placed food orders and print /
   photostat jobs. Reads the same session-backed
   demo data stores used by the student app.
   TODO(Firebase): admin reads real Firestore data.
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
    function ($scope, $location, $interval, $window, AuthService, QueueService, FoodOrderService) {

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
       * Reads every stored food order across all students
       * (keys of the form queueSync_foodOrder_<studentId>).
       */
      function readAllFoodOrders() {
        var orders = [];
        try {
          for (var i = 0; i < $window.sessionStorage.length; i++) {
            var key = $window.sessionStorage.key(i);
            if (key && key.indexOf('queueSync_foodOrder_') === 0) {
              var sid = key.replace('queueSync_foodOrder_', '');
              try {
                var order = JSON.parse($window.sessionStorage.getItem(key));
                if (order && order.orderNo) {
                  order._studentId = sid;
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

      /**
       * Reads every stored print / photostat job
       * (keys of the form queueSync_photostatJob_<studentId>).
       */
      function readAllPhotostatJobs() {
        var jobs = [];
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
          return new Date(b.paidAt) - new Date(a.paidAt);
        });
        return jobs;
      }

      /**
       * Refreshes every panel on the dashboard.
       */
      $scope.refresh = function () {
        $scope.isLoading = true;

        var cq = QueueService.getQueue('canteen');
        $scope.canteen.members = cq ? cq.members.slice() : [];
        $scope.canteen.count = $scope.canteen.members.length;

        var pq = QueueService.getQueue('photostat');
        $scope.photostat.members = pq ? pq.members.slice() : [];
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
        $scope.photostatJobs.forEach(function (j) { if (j._studentId) { studentIds[j._studentId] = true; } });

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

      /**
       * Total quantity ordered for a given menu item.
       */
      $scope.orderItemCount = function (itemId) {
        var count = 0;
        ($scope.orders || []).forEach(function (o) {
          (o.items || []).forEach(function (it) {
            if (it.itemId === itemId) { count += it.qty; }
          });
        });
        return count;
      };

      $scope.orderTypeLabel = function (id) {
        var map = { takeaway: 'Takeaway', pickup: 'Pickup', 'dine-in': 'Dine-in' };
        return map[id] || id || '\u2014';
      };

      /**
       * Formats a stored timestamp for display.
       */
      $scope.formatTime = function (value) {
        var d = new Date(value);
        if (isNaN(d.getTime())) { return '\u2014'; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
      };

      /**
       * Formats a stored date for display.
       */
      $scope.formatDate = function (value) {
        var d = new Date(value);
        if (isNaN(d.getTime())) { return '\u2014'; }
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

      // Keep the dashboard live while it is open.
      var interval = $interval($scope.refresh, 10000);

      $scope.$on('$destroy', function () {
        if (interval) { $interval.cancel(interval); }
      });
    }
  ]);
})();