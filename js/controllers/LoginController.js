/* ============================================
   QueueSync - LoginController
   Handles student ID input validation & submission
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('LoginController', [
    '$scope',
    '$location',
    '$timeout',
    'AuthService',
    function ($scope, $location, $timeout, AuthService) {

      // If user is already authenticated, redirect straight to home
      if (AuthService.isLoggedIn()) {
        $location.path('/home');
        return;
      }

      $scope.studentId = '';
      $scope.errorMessage = '';
      $scope.isSubmitting = false;

      /**
       * Handles login form submission with strict ID validation:
       * - Exactly 5 digits
       * - Must end with 23, 24, 25, or 26
       */
      $scope.handleLogin = function () {
        $scope.errorMessage = '';

        if ($scope.isSubmitting) {
          return;
        }

        var validationError = AuthService.validateStudentId($scope.studentId);
        if (validationError) {
          $scope.errorMessage = validationError;
          return;
        }

        var cleanId = String($scope.studentId).trim();
        $scope.isSubmitting = true;

        // Simulate brief server authentication / verification latency
        $timeout(function () {
          AuthService.login(cleanId);
          $scope.isSubmitting = false;
          $location.path('/home');
        }, 500);
      };

      // Clear error as user types
      $scope.$watch('studentId', function (newVal, oldVal) {
        if (newVal !== oldVal && $scope.errorMessage) {
          $scope.errorMessage = '';
        }
      });
    }
  ]);
})();
