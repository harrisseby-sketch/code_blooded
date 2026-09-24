/* ============================================
   QueueSync - AdminController (thin view layer)
   Admin dashboard: live queue occupancy, food
   stock / availability, placed food orders and
   print / photostat jobs.

   All state + actions live in AdminService; this
   controller only:
     - guards the /admin route to admins,
     - binds AdminService state to the template,
     - owns UI-only concerns (confirm dialogs,
       double-click guards, toasts) on top of
       AdminService.serveCurrent / openPrint.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('AdminController', [
    '$scope',
    '$location',
    '$window',
    'AuthService',
    'QueueService',
    'AdminService',
    'MultiDeviceSyncService',
    function ($scope, $location, $window, AuthService, QueueService, AdminService, MultiDeviceSyncService) {

      // Admin-only route guard
      if (!AuthService.isAdmin()) {
        $location.path('/login');
        return;
      }

      var state = AdminService.getState();

      // ---- Live state binding ----
      $scope.isLoading = false;
      $scope.refreshedAt = null;
      $scope.nowServing = state.nowServing;
      $scope.isActing = { canteen: false, photostat: false };

      function copyState() {
        $scope.isLoading = state.isLoading;
        $scope.refreshedAt = state.refreshedAt;
        $scope.canteen = state.canteen;
        $scope.photostat = state.photostat;
        $scope.menu = state.menu;
        $scope.orders = state.orders;
        $scope.photostatJobs = state.photostatJobs;
        $scope.stats = state.stats;
        $scope.canteenLive = state.canteenLive;
        $scope.photostatLive = state.photostatLive;
      }

      // Pure helpers / actions delegated to AdminService.
      $scope.refresh = AdminService.refresh;
      $scope.formatTime = AdminService.formatTime;
      $scope.formatDate = AdminService.formatDate;
      $scope.orderTypeLabel = AdminService.orderTypeLabel;
      $scope.orderItemCount = AdminService.orderItemCount;
      $scope.toggleAvailability = AdminService.toggleAvailability;
      $scope.restock = AdminService.restock;
      $scope.adjustStock = AdminService.adjustStock;

      copyState();
      var unbindState = AdminService.onState(copyState);

      // ---- Multi-device sync status (live order counts across devices) ----
      $scope.sync = MultiDeviceSyncService.getStatus();
      $scope.retrySync = function () {
        MultiDeviceSyncService.retry();
        $scope.sync = MultiDeviceSyncService.getStatus();
      };
      var unbindSync = $scope.$on('sync:status', function (event, status) {
        $scope.sync = status;
      });

      /**
       * Admin logout - clears both the admin and any leftover student session
       * so the logout always returns to the clean login page.
       */
      $scope.logoutAdmin = function () {
        AdminService.adminLogout();
        $location.path('/login');
      };

      // ==========================================================
      //            NOW SERVING - ADMIN ACTIONS
      // ==========================================================

      /**
       * Canteen: single "Mark as Served" action. Confirms, then serves the
       * current request via AdminService.serveCurrent, which atomically
       * archives + deletes the member doc in Firestore (or pops it locally
       * in demo mode). The next entry becomes "Now Serving" automatically.
       */
      $scope.serveCanteen = function () {
        if ($scope.isActing.canteen) { return; }
        var ns = $scope.nowServing.canteen;
        if (!ns) {
          QueueService.showToast('No pending request in the canteen queue.', 'info');
          return;
        }
        if (!$window.confirm('Mark student ' + ns.studentId + ' as served?\nThey will be called to the counter and removed from the queue.')) {
          return;
        }
        $scope.isActing.canteen = true;
        AdminService.serveCurrent('canteen')
          .then(function (res) {
            if (!res) {
              QueueService.showToast('That request was already served — queue advanced.', 'info');
              return;
            }
            QueueService.showToast('Served ' + res.studentId + '. The next request is now current.', 'success');
          })
          .catch(function (err) {
            console.error('[QueueSync] Canteen serve failed:', err);
            QueueService.showToast('Could not serve the request — check the console.', 'warning');
          })
          .finally(function () {
            $scope.isActing.canteen = false;
            AdminService.refresh();
          });
      };

      /**
       * Photostat: "Serve / Done". Confirms, then AdminService.serveCurrent
       * optionally deletes any uploaded file from Firebase Storage first
       * (best-effort), then serves + deletes the queue entry. Printing alone
       * (printPhotostat) never deletes the entry.
       */
      $scope.servePhotostat = function () {
        if ($scope.isActing.photostat) { return; }
        var ns = $scope.nowServing.photostat;
        if (!ns) {
          QueueService.showToast('No pending request in the photostat queue.', 'info');
          return;
        }
        var job = ns.request || {};
        if (!$window.confirm('Finish job ' + (job.orderNo || ns.studentId) + ' and mark as DONE?\nThe queue entry will be removed.')) {
          return;
        }

        $scope.isActing.photostat = true;
        AdminService.serveCurrent('photostat')
          .then(function (res) {
            if (!res) {
              QueueService.showToast('That job was already completed — queue advanced.', 'info');
              return;
            }
            QueueService.showToast('Job ' + (job.orderNo || res.studentId) + ' done. The next job is now current.', 'success');
          })
          .catch(function (err) {
            console.error('[QueueSync] Photostat serve failed:', err);
            QueueService.showToast('Could not complete the job — check the console.', 'warning');
          })
          .finally(function () {
            $scope.isActing.photostat = false;
            AdminService.refresh();
          });
      };

      /**
       * Photostat: "Print". Opens a print-ready layout for the current job in
       * a new tab and triggers window.print(). Printing alone does NOT delete
       * the queue entry — that only happens via servePhotostat().
       */
      $scope.printPhotostat = function () {
        if (!state.nowServing.photostat) {
          QueueService.showToast('No pending request to print.', 'info');
          return;
        }
        var opened = AdminService.openPrint();
        if (!opened) {
          QueueService.showToast('Popup blocked — allow popups to print jobs.', 'warning');
        }
      };

      $scope.$on('$destroy', function () {
        if (unbindState) { unbindState(); }
        if (unbindSync) { unbindSync(); }
      });
    }
  ]);

})();