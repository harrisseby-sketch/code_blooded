/* ============================================
   QueueSync - OrderService
   Canteen food ordering: menu catalog, cart and
   placed orders. Session-backed like the other
   demo services, so a user's cart survives
   navigation (and refresh) while logged in.

   TODO: menu items become a shared collection
   and each order is written to a shared order log
   so the kitchen counter sees it in real time.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('OrderService', [
    '$window',
    'AuthService',
    function ($window, AuthService) {

      var CART_KEY = 'queueSync_cart_';
      var ORDER_KEY = 'queueSync_order_';

      var MENU = [
        { id: 'samosa', itemName: 'Samosa', emoji: '🥟', price: 15, category: 'Snacks', veg: true },
        { id: 'veg-puff', itemName: 'Veg Puff', emoji: '🥐', price: 20, category: 'Snacks', veg: true },
        { id: 'fries', itemName: 'French Fries', emoji: '🍟', price: 50, category: 'Snacks', veg: true },
        { id: 'spring-roll', itemName: 'Veg Spring Rolls', emoji: '🌯', price: 45, category: 'Snacks', veg: true },
        { id: 'veg-thali', itemName: 'Veg Thali', emoji: '🍛', price: 80, category: 'Meals', veg: true },
        { id: 'paneer-biryani', itemName: 'Paneer Biryani', emoji: '🍚', price: 90, category: 'Meals', veg: true },
        { id: 'veg-chowmein', itemName: 'Veg Chowmein', emoji: '🍜', price: 60, category: 'Meals', veg: true },
        { id: 'veg-burger', itemName: 'Veg Burger', emoji: '🍔', price: 65, category: 'Meals', veg: true },
        { id: 'masala-chai', itemName: 'Masala Chai', emoji: '🍵', price: 15, category: 'Beverages', veg: true },
        { id: 'cold-coffee', itemName: 'Cold Coffee', emoji: '🥤', price: 60, category: 'Beverages', veg: true },
        { id: 'lime-soda', itemName: 'Fresh Lime Soda', emoji: '🍋', price: 30, category: 'Beverages', veg: true },
        { id: 'choc-shake', itemName: 'Chocolate Milkshake', emoji: '🥛', price: 70, category: 'Beverages', veg: true },
        { id: 'gulab-jamun', itemName: 'Gulab Jamun', emoji: '🍮', price: 25, category: 'Desserts', veg: true },
        { id: 'ice-cream', itemName: 'Ice Cream Cup', emoji: '🍨', price: 40, category: 'Desserts', veg: true },
        { id: 'brownie', itemName: 'Chocolate Brownie', emoji: '🍫', price: 55, category: 'Desserts', veg: true },
        { id: 'fruit-custard', itemName: 'Fruit Custard', emoji: '🍓', price: 35, category: 'Desserts', veg: true }
      ];

      var pendingStudentId = null;
      var cart = {};
      var lastOrder = null;

      function currentStudentId() {
        return AuthService.getStudentId();
      }

      function loadState() {
        var sid = currentStudentId();
        if (pendingStudentId === sid) {
          return;
        }
        pendingStudentId = sid;
        cart = {};
        lastOrder = null;
        if (!sid) {
          return;
        }
        try {
          var cartRaw = $window.sessionStorage.getItem(CART_KEY + sid);
          if (cartRaw) {
            var parsed = JSON.parse(cartRaw);
            if (parsed && typeof parsed === 'object') {
              cart = parsed;
            }
          }
          var orderRaw = $window.sessionStorage.getItem(ORDER_KEY + sid);
          if (orderRaw) {
            lastOrder = JSON.parse(orderRaw);
          }
        } catch (e) {
          cart = {};
          lastOrder = null;
        }
      }

      function persistCart() {
        var sid = currentStudentId();
        if (!sid) { return; }
        try {
          $window.sessionStorage.setItem(CART_KEY + sid, JSON.stringify(cart));
        } catch (e) { /* noop */ }
      }

      function persistOrder() {
        var sid = currentStudentId();
        if (!sid) { return; }
        try {
          $window.sessionStorage.setItem(ORDER_KEY + sid, JSON.stringify(lastOrder));
        } catch (e) { /* noop */ }
      }

      function getMenu() {
        return angular.copy(MENU);
      }

      function getCategories() {
        var seen = {};
        MENU.forEach(function (item) { seen[item.category] = true; });
        return Object.keys(seen);
      }

      function addToCart(itemId) {
        loadState();
        cart[itemId] = (cart[itemId] || 0) + 1;
        persistCart();
      }

      function removeFromCart(itemId) {
        loadState();
        if (!cart[itemId]) { return; }
        cart[itemId] -= 1;
        if (cart[itemId] <= 0) {
          delete cart[itemId];
        }
        persistCart();
      }

      function clearCart() {
        loadState();
        cart = {};
        persistCart();
      }

      function getQty(itemId) {
        loadState();
        return cart[itemId] || 0;
      }

      function getCartItems() {
        loadState();
        var lines = [];
        MENU.forEach(function (item) {
          var qty = cart[item.id] || 0;
          if (qty > 0) {
            lines.push({ item: item, qty: qty, lineTotal: item.price * qty });
          }
        });
        return lines;
      }

      function getCartCount() {
        var lines = getCartItems();
        var total = 0;
        lines.forEach(function (line) { total += line.qty; });
        return total;
      }

      function getCartTotal() {
        var lines = getCartItems();
        var total = 0;
        lines.forEach(function (line) { total += line.lineTotal; });
        return total;
      }

      function placeOrder() {
        loadState();
        var sid = currentStudentId();
        if (!sid) {
          return null;
        }
        var lines = getCartItems();
        var items = [];
        var total = 0;
        lines.forEach(function (line) {
          items.push({
            id: line.item.id,
            itemName: line.item.itemName,
            emoji: line.item.emoji,
            price: line.item.price,
            qty: line.qty,
            lineTotal: line.lineTotal
          });
          total += line.lineTotal;
        });

        var order = {
          orderNo: generateOrderNumber(),
          locationId: 'canteen',
          studentId: sid,
          items: items,
          total: total,
          placedAt: new Date(),
          status: 'Placed'
        };

        lastOrder = order;
        cart = {};
        persistCart();
        persistOrder();
        return order;
      }

      function generateOrderNumber() {
        return 'QS-' + Math.floor(10000 + Math.random() * 90000);
      }

      function getLastOrder() {
        loadState();
        return lastOrder;
      }

      return {
        getMenu: getMenu,
        getCategories: getCategories,
        addToCart: addToCart,
        removeFromCart: removeFromCart,
        clearCart: clearCart,
        getQty: getQty,
        getCartItems: getCartItems,
        getCartCount: getCartCount,
        getCartTotal: getCartTotal,
        placeOrder: placeOrder,
        getLastOrder: getLastOrder
      };
    }
  ]);
})();