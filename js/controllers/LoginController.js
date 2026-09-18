/* ============================================
   QueueSync - LoginController
   Handles student ID validation & submission,
   plus an adjacent admin login using a special
   access code.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('LoginController', [
    '$scope',
    '$location',
    '$timeout',
    'AuthService',
    function ($scope, $location, $timeout, AuthService) {

      // If an admin session is already active, go straight to the dashboard
      if (AuthService.isAdmin()) {
        $location.path('/admin');
        return;
      }

      // If user is already authenticated, redirect straight to home
      if (AuthService.isLoggedIn()) {
        $location.path('/home');
        return;
      }

      $scope.role = 'student';
      $scope.studentId = '';
      $scope.adminCode = '';
      $scope.errorMessage = '';
      $scope.isSubmitting = false;

      /**
       * Switches between the Student and Admin login panels.
       * The demo admin code is pre-filled so admin login is a single click.
       */
      $scope.switchRole = function (role) {
        if ($scope.isSubmitting || $scope.role === role) {
          return;
        }
        $scope.role = role;
        $scope.errorMessage = '';
        if (role === 'admin') {
          $scope.adminCode = 'ADMIN@2026';
        }
      };

      /**
       * Handles login form submission with strict ID validation:
       * - Exactly 5 digits
       * - Must end with 23, 24, 25, or 26
       */
      $scope.handleLogin = function () {
        $scope.errorMessage = '';

        if ($scope.role !== 'student' || $scope.isSubmitting) {
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

      /**
       * Handles admin login with the special access code.
       */
      $scope.handleAdminLogin = function () {
        $scope.errorMessage = '';

        if ($scope.role !== 'admin' || $scope.isSubmitting) {
          return;
        }

        var code = String($scope.adminCode || '').trim();
        if (!code) {
          $scope.errorMessage = 'Enter the admin access code.';
          return;
        }
        if (!AuthService.validateAdminCode(code)) {
          $scope.errorMessage = 'Invalid admin code. Access denied.';
          return;
        }

        $scope.isSubmitting = true;

        // Simulate brief server verification latency
        $timeout(function () {
          AuthService.adminLogin(code);
          if (!AuthService.isAdmin()) {
            $scope.errorMessage = 'Could not start the admin session. Try again.';
            $scope.isSubmitting = false;
            return;
          }
          $scope.isSubmitting = false;
          $location.path('/admin');
        }, 500);
      };

      // Clear error as user types
      $scope.$watch('studentId', function (newVal, oldVal) {
        if (newVal !== oldVal && $scope.errorMessage) {
          $scope.errorMessage = '';
        }
      });

      // Clear error as admin types
      $scope.$watch('adminCode', function (newVal, oldVal) {
        if (newVal !== oldVal && $scope.errorMessage) {
          $scope.errorMessage = '';
        }
      });
    }
  ]);
})();
