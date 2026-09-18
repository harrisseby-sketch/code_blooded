/* ============================================
   QueueSync - PhotostatQueueController
   Detailed queue controls & live stats for Photostat.
   Includes the dynamic user position panel, live
   status reporting and the "you're next" flow.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('PhotostatQueueController', [
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

      $scope.locationId = 'photostat';
      $scope.studentId = AuthService.getStudentId();

      $scope.queue = QueueService.getQueue('photostat');
      $scope.queueInfo = QueueService.getQueueInfo('photostat');
      $scope.userStatus = QueueService.getUserStatus('photostat');
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
        $scope.queue = QueueService.getQueue('photostat');
        $scope.queueInfo = QueueService.getQueueInfo('photostat');
        $scope.userStatus = QueueService.getUserStatus('photostat');
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
       * Join Photostat Shop Queue
       */
      $scope.joinQueue = function () {
        if ($scope.isUpdating || $scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.joinQueue('photostat', $scope.studentId)
          .then(function () { refresh(); })
          .catch(function (err) {
            console.error('Failed to join queue:', err);
          })
          .finally(function () {
            $scope.isUpdating = false;
          });
      };

      /**
       * Leave Photostat Shop Queue
       */
      $scope.leaveQueue = function () {
        if ($scope.isUpdating || !$scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.leaveQueue('photostat', $scope.studentId)
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
        QueueService.updateLiveStatus('photostat', $scope.studentId, value)
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

      // Periodic refresh keeps "Right now" advice + positions live.
      var interval = $interval(refresh, 15000);

      // Real-time update listeners
      var unbindUpdated = $scope.$on('queue:updated', function (event, data) {
        if (data.locationId === 'photostat') {
          refresh();
        }
      });
      var unbindLive = $scope.$on('queue:liveStatus', function (event, data) {
        if (data.locationId === 'photostat') {
          refresh();
        }
      });
      var unbindServed = $scope.$on('queue:served', function (event, data) {
        if (data.locationId === 'photostat') {
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