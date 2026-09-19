/* ============================================
   QueueSync - FoodCartController
   Shopping cart for campus food: shows every
   added line with its customizations and live
   pricing, lets the student edit quantities or
   customizations, remove lines, clear the cart
   and proceed to checkout.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('FoodCartController', [
    '$scope',
    '$location',
    '$timeout',
    'AuthService',
    'FoodOrderService',
    'QueueService',
    function ($scope, $location, $timeout, AuthService, FoodOrderService, QueueService) {

      // Route Guard
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.loading = true;

      $scope.refresh = function () {
        $scope.lines = FoodOrderService.getCartLines();
        $scope.summary = FoodOrderService.getCartSummary();
      };

      $scope.refresh();

      // Simulate a short read so the loading state is visible.
      $timeout(function () {
        $scope.loading = false;
      }, 400);

      // ---- Customization edits (applied immediately) ----

      $scope.isSelected = function (line, option, choice) {
        var value = line.config[option.id];
        if (option.type === 'multi') {
          return value.indexOf(choice.id) > -1;
        }
        return value === choice.id;
      };

      $scope.select = function (line, option, choice) {
        if (option.type === 'multi') {
          var list = line.config[option.id];
          var index = list.indexOf(choice.id);
          if (index > -1) {
            list.splice(index, 1);
          } else {
            list.push(choice.id);
          }
        } else {
          line.config[option.id] = choice.id;
        }
        FoodOrderService.updateLine(line.key, line.config, line.qty);
        $scope.refresh();
      };

      // ---- Quantity edits ----

      $scope.incQty = function (line) {
        if (line.qty < FoodOrderService.MAX_QTY) {
          FoodOrderService.updateLine(line.key, line.config, line.qty + 1);
          $scope.refresh();
        }
      };

      $scope.decQty = function (line) {
        if (line.qty > FoodOrderService.MIN_QTY) {
          FoodOrderService.updateLine(line.key, line.config, line.qty - 1);
          $scope.refresh();
        }
      };

      // ---- Line removal & clear all ----

      $scope.removeLine = function (line) {
        FoodOrderService.removeLine(line.key);
        $scope.refresh();
        QueueService.showToast('Item removed from your cart.', 'info');
      };

      $scope.clearCart = function () {
        FoodOrderService.clearCart();
        $scope.refresh();
        QueueService.showToast('Cart cleared.', 'info');
      };

      $scope.goToCheckout = function () {
        $location.path('/food/checkout');
      };

      $scope.goBack = function () {
        $location.path('/food');
      };

      // Live sync: cart edits from another tab (or admin-driven changes)
      // refresh this view instantly.
      var unbindCart = $scope.$on('food:cartUpdated', function () {
        $scope.refresh();
      });
      var unbindDb = $scope.$on('db:changed', function () {
        $scope.refresh();
      });
      $scope.$on('$destroy', function () {
        if (unbindCart) { unbindCart(); }
        if (unbindDb) { unbindDb(); }
      });
    }
  ]);
})();