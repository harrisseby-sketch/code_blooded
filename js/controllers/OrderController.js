/* ============================================
   QueueSync - OrderController
   Canteen food ordering flow: reachable when the
   student is at the front of the canteen queue
   (position #1, being served). Shows the menu,
   manages the cart and confirms the placed order.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('OrderController', [
    '$scope',
    '$location',
    'AuthService',
    'QueueService',
    'OrderService',
    function ($scope, $location, AuthService, QueueService, OrderService) {

      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.studentId = AuthService.getStudentId();
      $scope.menu = OrderService.getMenu();
      $scope.categories = OrderService.getCategories();
      $scope.activeCategory = null;
      $scope.orderPlaced = false;
      $scope.order = null;
      $scope.isPlacing = false;

      $scope.userStatus = QueueService.getUserStatus('canteen');

      // Access guard: food ordering is only allowed at the front of the
      // canteen queue. A recently placed order keeps the confirmation
      // reachable even after the queue simulation marks the student served.
      var atFront = $scope.userStatus.joined && $scope.userStatus.position === 1;
      var liveOrder = OrderService.getLastOrder();

      if (!atFront && !liveOrder) {
        QueueService.showToast('You can order food only after you reach the front of the canteen queue.', 'info');
        $location.path('/queue/canteen');
        return;
      }

      if (liveOrder && !$scope.orderPlaced) {
        $scope.orderPlaced = true;
        $scope.order = liveOrder;
      }

      function refreshCart() {
        $scope.cart = OrderService.getCartItems();
        $scope.cartCount = OrderService.getCartCount();
        $scope.cartTotal = OrderService.getCartTotal();
      }

      refreshCart();

      $scope.filteredMenu = function () {
        if (!$scope.activeCategory) {
          return $scope.menu;
        }
        return $scope.menu.filter(function (item) {
          return item.category === $scope.activeCategory;
        });
      };

      $scope.cartQty = function (itemId) {
        return OrderService.getQty(itemId);
      };

      $scope.setCategory = function (category) {
        $scope.activeCategory = $scope.activeCategory === category ? null : category;
      };

      $scope.addItem = function (item) {
        OrderService.addToCart(item.id);
        refreshCart();
      };

      $scope.removeItem = function (item) {
        OrderService.removeFromCart(item.id);
        if (OrderService.getQty(item.id) === 0 && $scope.activeCategory) {
          $scope.activeCategory = null;
        }
        refreshCart();
      };

      $scope.placeOrder = function () {
        if ($scope.isPlacing || $scope.cartCount === 0) {
          return;
        }
        $scope.isPlacing = true;
        var order = OrderService.placeOrder();
        $scope.order = order;
        $scope.orderPlaced = true;
        $scope.isPlacing = false;
        refreshCart();
        QueueService.showToast('Order ' + order.orderNo + ' placed — collect it at Counter 1!', 'success');
      };

      $scope.goBack = function () {
        $location.path('/queue/canteen');
      };

      $scope.goHome = function () {
        $location.path('/home');
      };
    }
  ]);
})();