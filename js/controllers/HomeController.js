/* ============================================
   QueueSync - HomeController
   Manages campus queue cards: busyness badge,
   predictive wait time, best-time recommendation,
   live status, and navigation.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('HomeController', [
    '$scope',
    '$location',
    '$interval',
    'AuthService',
    'QueueService',
    function ($scope, $location, $interval, AuthService, QueueService) {

      // Route Guard
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.studentId = AuthService.getStudentId();
      $scope.queues = QueueService.getQueues();

      // Location cards to render (order matters for the grid).
      $scope.locations = ['canteen', 'photostat'];

      // Cache of computed info per location so templates read fast.
      $scope.queueInfo = {
        canteen: QueueService.getQueueInfo('canteen'),
        photostat: QueueService.getQueueInfo('photostat')
      };

      /**
       * Recomputes the card info for every location (busyness, wait time,
       * live status, best-time advice). Called periodically so the
       * time-of-day advice stays live, and after queue events.
       */
      function refreshQueueInfo() {
        $scope.locations.forEach(function (locationId) {
          $scope.queueInfo[locationId] = QueueService.getQueueInfo(locationId);
        });
      }

      refreshQueueInfo();

      /**
       * Returns whether the logged-in student is currently queued at a location
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
       * Navigates to the profile / user details view
       */
      $scope.goToProfile = function () {
        $location.path('/profile');
      };

      /**
       * Logs out and redirects to login
       */
      $scope.logout = function () {
        AuthService.logout();
        $location.path('/login');
      };

      // Periodic refresh keeps "Right now" recommendations accurate.
      var queueInfoInterval = $interval(refreshQueueInfo, 15000);

      // Listen for updates from other views or services
      var unbindWatcher = $scope.$on('queue:updated', refreshQueueInfo);
      var unbindLiveStatus = $scope.$on('queue:liveStatus', refreshQueueInfo);
      var unbindServed = $scope.$on('queue:served', refreshQueueInfo);

      $scope.$on('$destroy', function () {
        if (queueInfoInterval) {
          $interval.cancel(queueInfoInterval);
        }
        if (unbindWatcher) { unbindWatcher(); }
        if (unbindLiveStatus) { unbindLiveStatus(); }
        if (unbindServed) { unbindServed(); }
      });
    }
  ]);
})();