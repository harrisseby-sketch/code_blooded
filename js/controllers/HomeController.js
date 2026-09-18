/* ============================================
   QueueSync - HomeController
   Manages campus queue cards, metrics, and navigation
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('HomeController', [
    '$scope',
    '$location',
    'AuthService',
    'QueueService',
    function ($scope, $location, AuthService, QueueService) {

      // Route Guard
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.studentId = AuthService.getStudentId();
      $scope.queues = QueueService.getQueues();

      /**
       * Returns whether the logged-in student is currently queued at this location
       */
      $scope.getUserStatus = function (locationId) {
        return QueueService.getUserStatus(locationId);
      };

      /**
       * Navigates to the detailed queue view
       */
      $scope.goToQueue = function (locationId) {
        $location.path('/queue/' + locationId);
      };

      /**
       * Logs out and redirects to login
       */
      $scope.logout = function () {
        AuthService.logout();
        $location.path('/login');
      };

      // Listen for updates from other views or services
      var unbindWatcher = $scope.$on('queue:updated', function () {
        $scope.queues = QueueService.getQueues();
      });

      $scope.$on('$destroy', function () {
        if (unbindWatcher) {
          unbindWatcher();
        }
      });
    }
  ]);
})();
