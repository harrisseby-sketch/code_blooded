/* ============================================
   QueueSync - CanteenQueueController
   Detailed queue controls & live stats for Canteen.
   Includes the dynamic user position panel, live
   status reporting and the "you're next" flow.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('CanteenQueueController', [
    '$scope',
    '$location',
    '$interval',
    'AuthService',
    'QueueService',
    function ($scope, $location, $interval, AuthService, QueueService) {

      // Ensure user is authenticated
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.locationId = 'canteen';
      $scope.studentId = AuthService.getStudentId();

      $scope.queue = QueueService.getQueue('canteen');
      $scope.queueInfo = QueueService.getQueueInfo('canteen');
      $scope.userStatus = QueueService.getUserStatus('canteen');
      $scope.myStatus = null;
      $scope.isUpdating = false;
      $scope.simSpeed = QueueService.getSimulationSpeed();

      // Live status report options for users currently in the queue.
      $scope.liveStatusOptions = [
        { value: 'fast',   label: 'Moving fast' },
        { value: 'normal', label: 'Normal' },
        { value: 'slow',   label: 'Moving slow' }
      ];

      /**
       * Refreshes everything bound to this page (queue, info, positions).
       */
      function refresh() {
        $scope.queue = QueueService.getQueue('canteen');
        $scope.queueInfo = QueueService.getQueueInfo('canteen');
        $scope.userStatus = QueueService.getUserStatus('canteen');
        $scope.simSpeed = QueueService.getSimulationSpeed();

        // Pre-select the user's current report (if any).
        if ($scope.queue) {
          $scope.myStatus = null;
          if ($scope.userStatus.joined) {
            for (var i = 0; i < $scope.queue.liveStatusReports.length; i++) {
              if ($scope.queue.liveStatusReports[i].studentId === $scope.studentId) {
                $scope.myStatus = $scope.queue.liveStatusReports[i].status;
                break;
              }
            }
          }
        }
      }

      refresh();

      /**
       * Join Canteen Queue
       * Canteen uses a checkout-first flow: the user is added to the queue
       * automatically after their food order is paid online. A direct
       * join is intentionally not offered on the queue tab.
       */
      $scope.joinQueue = function () {
        if ($scope.isUpdating || $scope.userStatus.joined) {
          return;
        }
        QueueService.showToast('Order food and pay online to join the queue automatically.', 'info');
      };

      /**
       * Leave Canteen Queue
       */
      $scope.leaveQueue = function () {
        if ($scope.isUpdating || !$scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.leaveQueue('canteen', $scope.studentId)
          .then(function () { refresh(); })
          .catch(function (err) {
            console.error('Failed to leave queue:', err);
          })
          .finally(function () {
            $scope.isUpdating = false;
          });
      };

      /**
       * Records the current user's live-status report for this queue.
       */
      $scope.setLiveStatus = function (value) {
        if (!$scope.userStatus.joined) {
          return;
        }
        QueueService.updateLiveStatus('canteen', $scope.studentId, value)
          .then(function () {
            $scope.myStatus = value;
            refresh();
          })
          .catch(function (err) {
            console.error('Failed to update live status:', err);
          });
      };

      /**
       * Demo helper: cycles simulation speed (1x, 30x, 120x).
       */
      $scope.cycleSimSpeed = function () {
        var next = $scope.simSpeed >= 120 ? 1 : ($scope.simSpeed * 30);
        QueueService.setSimulationSpeed(next);
        refresh();
      };

      /**
       * Return to home view
       */
      $scope.goBack = function () {
        $location.path('/home');
      };

      $scope.goToProfile = function () {
        $location.path('/profile');
      };

      /**
       * Jump straight to the standalone food ordering flow.
       */
      $scope.goToOrder = function () {
        $location.path('/food');
      };

      // Periodic refresh keeps "Right now" advice + positions live.
      var interval = $interval(refresh, 15000);

      // Real-time update listeners
      var unbindUpdated = $scope.$on('queue:updated', function (event, data) {
        if (data.locationId === 'canteen') {
          refresh();
        }
      });
      var unbindLive = $scope.$on('queue:liveStatus', function (event, data) {
        if (data.locationId === 'canteen') {
          refresh();
        }
      });
      var unbindServed = $scope.$on('queue:served', function (event, data) {
        if (data.locationId === 'canteen') {
          refresh();
        }
      });
      var unbindNext = $scope.$on('queue:next', function () {
        refresh();
      });

      $scope.$on('$destroy', function () {
        if (interval) { $interval.cancel(interval); }
        if (unbindUpdated) { unbindUpdated(); }
        if (unbindLive) { unbindLive(); }
        if (unbindServed) { unbindServed(); }
        if (unbindNext) { unbindNext(); }
      });
    }
  ]);
})();