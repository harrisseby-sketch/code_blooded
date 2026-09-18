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
        .when('/admin', {
          templateUrl: 'templates/admin.html',
          controller: 'AdminController'
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
        .when('/order/canteen', {
          templateUrl: 'templates/order.html',
          controller: 'OrderController'
        })
        .when('/food', {
          templateUrl: 'templates/food.html',
          controller: 'FoodController'
        })
        .when('/food/cart', {
          templateUrl: 'templates/food-cart.html',
          controller: 'FoodCartController'
        })
        .when('/food/checkout', {
          templateUrl: 'templates/food-checkout.html',
          controller: 'FoodCheckoutController'
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
    'FoodOrderService',
    function ($rootScope, $location, AuthService, QueueService, FoodOrderService) {
      // Expose services to root scope for layout components (navbar, toast, banner)
      $rootScope.auth = AuthService;
      $rootScope.toast = QueueService.toastState;

      // Global "You're next" notification state (rendered app-wide in index.html)
      $rootScope.nextNotification = QueueService.nextNotification;

      /**
       * Cart badge state for the Food tab in the top navbar.
       */
      $rootScope.foodCartCount = FoodOrderService.getCartItemCount();
      $rootScope.$on('food:cartUpdated', function () {
        $rootScope.foodCartCount = FoodOrderService.getCartItemCount();
      });
      $rootScope.$on('$routeChangeSuccess', function () {
        $rootScope.foodCartCount = FoodOrderService.getCartItemCount();
      });

      /**
       * Global navigation to the campus Food ordering tab (navbar link)
       */
      $rootScope.goToFood = function () {
        $location.path('/food');
      };

      /**
       * Global Logout action accessible from top navbar.
       * Clears any student or admin session and resets the
       * in-memory demo data so the next login starts clean.
       */
      $rootScope.globalLogout = function () {
        AuthService.logout();
        AuthService.adminLogout();
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
        var isAdmin = AuthService.isAdmin();
        var targetPath = next.originalPath;

        // Admin session: only the admin dashboard is accessible.
        if (isAdmin && targetPath !== '/admin') {
          $location.path('/admin');
          return;
        }

        // Non-admins may never open the admin dashboard.
        if (!isAdmin && targetPath === '/admin') {
          $location.path('/login');
          return;
        }

        // If not logged in (as a student, or as an admin) and attempting to
        // access any page other than /login. Admins are never required to
        // hold a student session to open the dashboard.
        if (!isAuth && !isAdmin && targetPath !== '/login') {
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