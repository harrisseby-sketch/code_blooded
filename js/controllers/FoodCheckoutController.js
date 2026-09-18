/* ============================================
   QueueSync - FoodCheckoutController
   Checkout flow for campus food: order type,
   online payment method, final summary and
   placing the order. After a successful checkout
   a confirmation with a unique order number and
   the full summary is shown (restored from the
   last order on refresh).
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('FoodCheckoutController', [
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
      $scope.isPlacing = false;
      $scope.errors = {};
      $scope.joinedPosition = null;

      // Restore a recently placed order so the confirmation survives refresh.
      $scope.order = FoodOrderService.getLastOrder();
      $scope.placed = !!$scope.order;

      if (!FoodOrderService.getCartSummary().count) {
        if (!$scope.placed) {
          QueueService.showToast('Your cart is empty. Add some food first.', 'info');
          $location.path('/food');
          return;
        }
        // Confirmation view with an empty cart needs no live lines.
        $scope.lines = [];
        $scope.summary = {
          count: 0, lineCount: 0, subtotal: 0, tax: 0, taxLabel: '', total: 0
        };
      } else {
        $scope.lines = FoodOrderService.getCartLines();
        $scope.summary = FoodOrderService.getCartSummary();
      }

      // ---- Checkout form model ----

      $scope.customer = {
        orderType: 'takeaway',
        notes: '',
        payment: 'online',
        paymentOnline: 'upi'
      };

      $scope.orderTypes = [
        { id: 'takeaway', label: 'Takeaway', emoji: '🥡', hint: 'Packed to go' },
        { id: 'pickup', label: 'Pickup', emoji: '🛍️', hint: 'Collect at counter' },
        { id: 'dine-in', label: 'Dine-in', emoji: '🍽️', hint: 'Eat here' }
      ];

      $scope.paymentMethods = [
        { id: 'online', label: 'Online', emoji: '📱', hint: 'Pay now online' }
      ];

      $scope.onlineMethods = [
        { id: 'upi', label: 'UPI' },
        { id: 'card', label: 'Card' }
      ];

      $scope.paymentDetail = function () {
        return $scope.customer.paymentOnline === 'card' ? 'Card' : 'UPI';
      };

      // ---- Validation & placing ----

      $scope.placeOrder = function () {
        $scope.errors = {};

        $scope.isPlacing = true;

        // Simulate a short processing delay before confirming the order.
        $timeout(function () {
          var order = FoodOrderService.placeOrder({
            customerName: '',
            phone: '',
            orderType: $scope.customer.orderType,
            notes: ($scope.customer.notes || '').trim(),
            paymentMethod: $scope.customer.payment,
            paymentDetail: $scope.paymentDetail()
          });
          $scope.isPlacing = false;
          if (order) {
            $scope.order = order;
            $scope.placed = true;
            $scope.lines = [];
            $scope.summary = {
              count: 0, lineCount: 0, subtotal: 0, tax: 0, taxLabel: '', total: 0
            };

            // Online payment done — join the Canteen queue automatically.
            QueueService.joinQueue('canteen', $scope.studentId)
              .then(function (result) {
                $scope.joinedPosition = result.position;
                QueueService.showToast(
                  'Order ' + order.orderNo + ' placed \u2014 you joined the Canteen queue (spot #' + result.position + ')!',
                  'success'
                );
              })
              .catch(function (err) {
                console.error('Auto-join failed:', err);
                QueueService.showToast('Order placed, but we could not join the queue. Please try again.', 'warning');
              });
          } else {
            QueueService.showToast('Could not place the order. Please try again.', 'warning');
          }
        }, 900);
      };

      $scope.orderTypeLabel = function (id) {
        var found = $scope.orderTypes.filter(function (t) { return t.id === id; });
        return found.length ? found[0].label : id;
      };

      // ---- Navigation ----

      $scope.goHome = function () {
        $location.path('/home');
      };

      $scope.goToMenu = function () {
        FoodOrderService.clearLastOrder();
        $location.path('/food');
      };

      $scope.goBack = function () {
        if ($scope.placed) {
          $location.path('/food');
          return;
        }
        $location.path('/food/cart');
      };
    }
  ]);
})();