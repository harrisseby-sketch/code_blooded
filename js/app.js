/* ============================================
   QueueSync - Main Application Module & Routing
   AngularJS 1.x Architecture
   ============================================ */

(function () {
  'use strict';

  // Initialize AngularJS module with ngRoute
  var app = angular.module('queueSyncApp', ['ngRoute']);

  // --- Route Configuration ---
  app.config([
    '$routeProvider',
    '$locationProvider',
    function ($routeProvider, $locationProvider) {
      // Use hash-based routing (#/...) for universal compatibility
      $locationProvider.hashPrefix('');

      $routeProvider
        .when('/login', {
          templateUrl: 'templates/login.html',
          controller: 'LoginController'
        })
        .when('/home', {
          templateUrl: 'templates/home.html',
          controller: 'HomeController'
        })
        .when('/queue/canteen', {
          templateUrl: 'templates/canteen-queue.html',
          controller: 'CanteenQueueController'
        })
        .when('/queue/photostat', {
          templateUrl: 'templates/photostat-queue.html',
          controller: 'PhotostatQueueController'
        })
        .when('/profile', {
          templateUrl: 'templates/profile.html',
          controller: 'ProfileController'
        })
        .otherwise({
          redirectTo: '/home'
        });
    }
  ]);

  // --- Application Run Block: Route Guards & Global State ---
  app.run([
    '$rootScope',
    '$location',
    'AuthService',
    'QueueService',
    function ($rootScope, $location, AuthService, QueueService) {
      // Expose services to root scope for layout components (navbar, toast, banner)
      $rootScope.auth = AuthService;
      $rootScope.toast = QueueService.toastState;

      // Global "You're next" notification state (rendered app-wide in index.html)
      $rootScope.nextNotification = QueueService.nextNotification;

      /**
       * Global Logout action accessible from top navbar.
       * Also resets the in-memory demo data so the next login starts clean.
       */
      $rootScope.globalLogout = function () {
        AuthService.logout();
        QueueService.resetDemoData();
        $location.path('/login');
      };

      /**
       * Global navigation to the Profile / User Details page (navbar link)
       */
      $rootScope.goToProfile = function () {
        $location.path('/profile');
      };

      /**
       * Global Toast dismissal
       */
      $rootScope.dismissToast = function () {
        QueueService.hideToast();
      };

      /**
       * Global "You're next" banner dismissal
       */
      $rootScope.dismissNextNotification = function () {
        QueueService.dismissNextNotification();
      };

      /**
       * Global sound toggle for the "You're next" banner (muted by default)
       */
      $rootScope.toggleNextSound = function () {
        return QueueService.toggleNextSound();
      };

      // --- Route Authorization Guard ---
      $rootScope.$on('$routeChangeStart', function (event, next) {
        if (!next || !next.originalPath) {
          return;
        }

        var isAuth = AuthService.isLoggedIn();
        var targetPath = next.originalPath;

        // If not logged in and attempting to access any page other than /login
        if (!isAuth && targetPath !== '/login') {
          $location.path('/login');
        }

        // If already logged in and navigating to /login, redirect to /home
        if (isAuth && targetPath === '/login') {
          $location.path('/home');
        }
      });
    }
  ]);

})();