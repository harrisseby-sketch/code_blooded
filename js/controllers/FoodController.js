/* ============================================
   QueueSync - FoodController
   Campus food menu: browse dishes, filter by
   category, search, customize each item, see the
   price update live and add configured items to
   the cart.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('FoodController', [
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

      $scope.studentId = AuthService.getStudentId();
      $scope.menu = FoodOrderService.getMenu();
      $scope.categories = ['All'].concat(FoodOrderService.getCategories());
      $scope.activeCategory = 'All';
      $scope.search = '';
      $scope.loading = true;

      // Per-card customization state (keyed by item id)
      $scope.configs = {};
      $scope.qty = {};

      $scope.menu.forEach(function (item) {
        $scope.configs[item.id] = FoodOrderService.defaultConfig(item);
        $scope.qty[item.id] = 1;
      });

      // Simulate a short fetch so the loading state is visible.
      $timeout(function () {
        $scope.loading = false;
      }, 500);

      $scope.filteredMenu = function () {
        var query = ($scope.search || '').toLowerCase().trim();
        return $scope.menu.filter(function (item) {
          var matchCategory = $scope.activeCategory === 'All' || item.category === $scope.activeCategory;
          if (!matchCategory) {
            return false;
          }
          if (!query) {
            return true;
          }
          return item.name.toLowerCase().indexOf(query) > -1 ||
                 item.category.toLowerCase().indexOf(query) > -1 ||
                 item.description.toLowerCase().indexOf(query) > -1;
        });
      };

      $scope.setCategory = function (category) {
        $scope.activeCategory = category;
      };

      // ---- Customization helpers (shared shape for radio / multi chips) ----

      $scope.isSelected = function (item, option, choice) {
        var value = $scope.configs[item.id][option.id];
        if (option.type === 'multi') {
          return value.indexOf(choice.id) > -1;
        }
        return value === choice.id;
      };

      $scope.select = function (item, option, choice) {
        var config = $scope.configs[item.id];
        if (!item.available) {
          return;
        }
        if (option.type === 'multi') {
          var list = config[option.id];
          var index = list.indexOf(choice.id);
          if (index > -1) {
            list.splice(index, 1);
          } else {
            list.push(choice.id);
          }
        } else {
          config[option.id] = choice.id;
        }
      };

      // ---- Pricing (recomputed on every digest) ----

      $scope.unitPrice = function (item) {
        return FoodOrderService.getUnitPrice(item, $scope.configs[item.id]);
      };

      $scope.addonTotal = function (item) {
        return FoodOrderService.getAddonTotal(item, $scope.configs[item.id]);
      };

      $scope.cardPrice = function (item) {
        return FoodOrderService.getLineTotal(item, $scope.configs[item.id], $scope.qty[item.id]);
      };

      // ---- Quantity controls ----

      $scope.incQty = function (item) {
        if ($scope.qty[item.id] < FoodOrderService.MAX_QTY && item.available) {
          $scope.qty[item.id]++;
        }
      };

      $scope.decQty = function (item) {
        if ($scope.qty[item.id] > FoodOrderService.MIN_QTY && item.available) {
          $scope.qty[item.id]--;
        }
      };

      // ---- Cart actions ----

      $scope.inCartCount = function (item) {
        return FoodOrderService.getInCartCount(item.id);
      };

      $scope.addToCart = function (item) {
        if (!item.available) {
          return;
        }
        FoodOrderService.addToCart(item.id, $scope.configs[item.id], $scope.qty[item.id]);
        QueueService.showToast(item.name + ' added to your cart.', 'success');
      };

      $scope.summary = function () {
        return FoodOrderService.getCartSummary();
      };

      $scope.goToCart = function () {
        $location.path('/food/cart');
      };

      $scope.goBack = function () {
        $location.path('/home');
      };
    }
  ]);
})();