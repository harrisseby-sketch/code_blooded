/* ============================================
   QueueSync - CanteenQueueController
   Detailed queue controls & live stats for Canteen
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('CanteenQueueController', [
    '$scope',
    '$location',
    'AuthService',
    'QueueService',
    function ($scope, $location, AuthService, QueueService) {

      // Ensure user is authenticated
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.locationId = 'canteen';
      $scope.studentId = AuthService.getStudentId();
      $scope.queue = QueueService.getQueue('canteen');
      $scope.userStatus = QueueService.getUserStatus('canteen');
      $scope.isUpdating = false;

      /**
       * Join Canteen Queue
       */
      $scope.joinQueue = function () {
        if ($scope.isUpdating || $scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.joinQueue('canteen', $scope.studentId)
          .then(function (res) {
            $scope.queue = res.queue;
            $scope.userStatus = res.status;
          })
          .catch(function (err) {
            console.error('Failed to join queue:', err);
          })
          .finally(function () {
            $scope.isUpdating = false;
          });
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
          .then(function (res) {
            $scope.queue = res.queue;
            $scope.userStatus = res.status;
          })
          .catch(function (err) {
            console.error('Failed to leave queue:', err);
          })
          .finally(function () {
            $scope.isUpdating = false;
          });
      };

      /**
       * Return to home view
       */
      $scope.goBack = function () {
        $location.path('/home');
      };

      // Real-time update listener
      var unbind = $scope.$on('queue:updated', function (event, data) {
        if (data.locationId === 'canteen') {
          $scope.queue = data.queue;
          $scope.userStatus = QueueService.getUserStatus('canteen');
        }
      });

      $scope.$on('$destroy', function () {
        if (unbind) {
          unbind();
        }
      });
    }
  ]);
})();
