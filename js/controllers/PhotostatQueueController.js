/* ============================================
   QueueSync - PhotostatQueueController
   Detailed queue controls & live stats for Photostat Shop
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('PhotostatQueueController', [
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

      $scope.locationId = 'photostat';
      $scope.studentId = AuthService.getStudentId();
      $scope.queue = QueueService.getQueue('photostat');
      $scope.userStatus = QueueService.getUserStatus('photostat');
      $scope.isUpdating = false;

      /**
       * Join Photostat Shop Queue
       */
      $scope.joinQueue = function () {
        if ($scope.isUpdating || $scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.joinQueue('photostat', $scope.studentId)
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
       * Leave Photostat Shop Queue
       */
      $scope.leaveQueue = function () {
        if ($scope.isUpdating || !$scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.leaveQueue('photostat', $scope.studentId)
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
        if (data.locationId === 'photostat') {
          $scope.queue = data.queue;
          $scope.userStatus = QueueService.getUserStatus('photostat');
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
