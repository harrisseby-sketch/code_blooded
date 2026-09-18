/* ============================================
   QueueSync - ProfileController
   User Details section: read-only Student ID and
   the Recent Queues history list from UserService.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('ProfileController', [
    '$scope',
    '$location',
    'AuthService',
    'UserService',
    'QueueService',
    function ($scope, $location, AuthService, UserService, QueueService) {

      // Route Guard
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.studentId = AuthService.getStudentId();
      $scope.initials = String($scope.studentId || '').slice(-2);
      $scope.showAll = false;
      $scope.DEFAULT_VISIBLE = 5;

      /**
       * Reads the Recent Queues list (from session-backed UserService).
       * TODO(Firebase): becomes onSnapshot on users/{studentId}/history.
       */
      function loadHistory() {
        $scope.history = UserService.getQueueHistory();
      }

      loadHistory();

      /**
       * Labelled location name for an entry.
       */
      $scope.locationLabel = function (entry) {
        return UserService.getLocationLabel(entry.locationId);
      };

      /**
       * Formats a Date/timestamp to something like "Today, 12:45 PM" or
       * "Yesterday, 10:20 AM" or "Sep 12, 2:05 PM".
       */
      $scope.formatDateTime = function (dt) {
        if (!dt) {
          return '';
        }
        var date = dt instanceof Date ? dt : new Date(dt);
        if (isNaN(date.getTime())) {
          return '';
        }

        var now = new Date();
        var dayKey = function (d) {
          return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        };
        var today = dayKey(now);
        var target = dayKey(date);
        var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        var wasYesterday = target === dayKey(yesterday);

        var time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (target === today) {
          return 'Today, ' + time;
        }
        if (wasYesterday) {
          return 'Yesterday, ' + time;
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
      };

      /**
       * Entries actually rendered (3-5 by default, expandable).
       */
      $scope.visibleHistory = function () {
        return $scope.showAll ? $scope.history : $scope.history.slice(0, $scope.DEFAULT_VISIBLE);
      };

      $scope.toggleShowAll = function () {
        $scope.showAll = !$scope.showAll;
      };

      $scope.hasHistory = function () {
        return $scope.history && $scope.history.length > 0;
      };

      $scope.goHome = function () {
        $location.path('/home');
      };

      // Refresh history when the user completes/leaves a queue while on this page.
      var unbindServed = $scope.$on('queue:served', loadHistory);
      $scope.$on('$destroy', function () {
        if (unbindServed) { unbindServed(); }
      });
    }
  ]);
})();