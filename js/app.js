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
      // Expose services to root scope for layout components (navbar, toast)
      $rootScope.auth = AuthService;
      $rootScope.toast = QueueService.toastState;

      /**
       * Global Logout action accessible from top navbar
       */
      $rootScope.globalLogout = function () {
        AuthService.logout();
        $location.path('/login');
      };

      /**
       * Global Toast dismissal
       */
      $rootScope.dismissToast = function () {
        QueueService.hideToast();
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
