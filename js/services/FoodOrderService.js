/* ============================================
   QueueSync - FoodOrderService
   Campus food ordering: menu catalog (Biriyani,
   Alfam, Meals, Chapathi), item customizations,
   shopping cart, pricing & checkout.

   Session-backed like the other demo services:
   the cart and the last placed order survive
   navigation (and refresh) while logged in.

   Pricing model per item:
     - radio options (variant / portion / size /
       spice) apply a PER-UNIT delta
     - multi options (extra items / add-ons /
       sides) apply a ONE-TIME per-line delta
     - lineTotal = qty x unitPrice + addonTotal

   TODO(Firebase): menu items become a Firestore
   collection and each order is written to
   orders/{orderNo} so the food counter can see
   it in real time.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('FoodOrderService', [
    '$window',
    '$rootScope',
    'AuthService',
    function ($window, $rootScope, AuthService) {

      var CART_KEY = 'queueSync_foodCart_';
      var ORDER_KEY = 'queueSync_foodOrder_';

      var TAX_RATE = 0.05;
      var TAX_LABEL = 'GST (5%)';

      var MIN_QTY = 1;
      var MAX_QTY = 10;

      var MENU = [
        {
          id: 'biriyani',
          name: 'Biriyani',
          category: 'Biriyani',
          emoji: '🍛',
          description: 'Long-grain basmati rice slow-cooked with aromatic biriyani spices and your choice of protein.',
          basePrice: 120,
          unitHint: 'per plate',
          available: true,
          veg: false,
          options: [
            {
              id: 'variant',
              label: 'Choose your biriyani',
              type: 'radio',
              default: 'chicken',
              choices: [
                { id: 'chicken', label: 'Chicken', delta: 0 },
                { id: 'beef', label: 'Beef', delta: 30 },
                { id: 'mutton', label: 'Mutton', delta: 60 },
                { id: 'egg', label: 'Egg', delta: -10 },
                { id: 'veg', label: 'Vegetable', delta: -20 }
              ]
            }
          ]
        },
        {
          id: 'alfam',
          name: 'Alfam',
          category: 'Alfam',
          emoji: '🍜',
          description: 'Wok-tossed egg noodles with crunchy vegetables and a punchy house sauce.',
          basePrice: 90,
          unitHint: 'per plate',
          available: true,
          veg: false,
          options: [
            {
              id: 'portion',
              label: 'Portion',
              type: 'radio',
              default: 'full',
              choices: [
                { id: 'half', label: 'Half', delta: -30 },
                { id: 'full', label: 'Full', delta: 0 }
              ]
            },
            {
              id: 'spice',
              label: 'Spice level',
              type: 'radio',
              default: 'medium',
              choices: [
                { id: 'mild', label: 'Mild', delta: 0 },
                { id: 'medium', label: 'Medium', delta: 0 },
                { id: 'hot', label: 'Hot', delta: 0 }
              ]
            },
            {
              id: 'extras',
              label: 'Extra items',
              type: 'multi',
              choices: [
                { id: 'extra-egg', label: 'Egg', delta: 15 },
                { id: 'extra-chicken', label: 'Chicken', delta: 45 },
                { id: 'extra-prawn', label: 'Prawn', delta: 60 },
                { id: 'extra-noodles', label: 'Noodles', delta: 25 }
              ]
            }
          ]
        },
        {
          id: 'meals',
          name: 'Meals',
          category: 'Meals',
          emoji: '🍱',
          description: 'A wholesome plated meal with rice, curry, vegetables and a crispy paapad on the side.',
          basePrice: 70,
          unitHint: 'per plate',
          available: true,
          veg: true,
          options: [
            {
              id: 'size',
              label: 'Meal size',
              type: 'radio',
              default: 'regular',
              choices: [
                { id: 'regular', label: 'Regular meals', delta: 0 },
                { id: 'full', label: 'Full meals', delta: 20 }
              ]
            },
            {
              id: 'addons',
              label: 'Add-ons',
              type: 'multi',
              choices: [
                { id: 'extra-rice', label: 'Extra rice', delta: 20 },
                { id: 'extra-curry', label: 'Extra curry', delta: 25 },
                { id: 'extra-egg', label: 'Extra egg', delta: 15 },
                { id: 'side-dish', label: 'Side dish', delta: 30 }
              ]
            }
          ]
        },
        {
          id: 'chapathi',
          name: 'Chapathi',
          category: 'Chapathi',
          emoji: '🫓',
          description: 'Soft, hand-rolled whole-wheat flatbreads fresh off the tawa.',
          basePrice: 15,
          unitHint: 'per piece',
          available: true,
          veg: true,
          options: [
            {
              id: 'addons',
              label: 'Optional sides',
              type: 'multi',
              choices: [
                { id: 'curry', label: 'Curry', delta: 30 },
                { id: 'side-dish', label: 'Side dish', delta: 25 }
              ]
            }
          ]
        }
      ];

      var pendingStudentId = null;
      var cartLines = [];
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
        cartLines = [];
        lastOrder = null;
        if (!sid) {
          return;
        }
        try {
          var cartRaw = $window.sessionStorage.getItem(CART_KEY + sid);
          if (cartRaw) {
            var parsed = JSON.parse(cartRaw);
            if (parsed && angular.isArray(parsed)) {
              cartLines = parsed;
            }
          }
          var orderRaw = $window.sessionStorage.getItem(ORDER_KEY + sid);
          if (orderRaw) {
            lastOrder = JSON.parse(orderRaw);
          }
        } catch (e) {
          cartLines = [];
          lastOrder = null;
        }
      }

      function persistCart() {
        var sid = currentStudentId();
        if (!sid) { return; }
        try {
          $window.sessionStorage.setItem(CART_KEY + sid, JSON.stringify(cartLines));
        } catch (e) { /* noop */ }
        $rootScope.$broadcast('food:cartUpdated');
      }

      function persistOrder() {
        var sid = currentStudentId();
        if (!sid) { return; }
        try {
          $window.sessionStorage.setItem(ORDER_KEY + sid, JSON.stringify(lastOrder));
        } catch (e) { /* noop */ }
      }

      // ---- Menu helpers ----

      function getMenu() {
        return angular.copy(MENU);
      }

      function getCategories() {
        var seen = [];
        MENU.forEach(function (item) {
          if (seen.indexOf(item.category) === -1) {
            seen.push(item.category);
          }
        });
        return seen;
      }

      function getItemById(itemId) {
        for (var i = 0; i < MENU.length; i++) {
          if (MENU[i].id === itemId) {
            return MENU[i];
          }
        }
        return null;
      }

      function findChoice(opt, choiceId) {
        for (var i = 0; i < opt.choices.length; i++) {
          if (opt.choices[i].id === choiceId) {
            return opt.choices[i];
          }
        }
        return null;
      }

      function defaultConfig(item) {
        var config = {};
        (item.options || []).forEach(function (opt) {
          if (opt.type === 'multi') {
            config[opt.id] = [];
          } else {
            config[opt.id] = opt.default || (opt.choices[0] && opt.choices[0].id);
          }
        });
        return config;
      }

      // ---- Pricing ----

      function getUnitPrice(item, config) {
        var price = item.basePrice;
        (item.options || []).forEach(function (opt) {
          if (opt.type !== 'multi') {
            var choice = findChoice(opt, config[opt.id]);
            if (choice) {
              price += choice.delta;
            }
          }
        });
        return price;
      }

      function getAddonTotal(item, config) {
        var total = 0;
        (item.options || []).forEach(function (opt) {
          if (opt.type === 'multi') {
            (config[opt.id] || []).forEach(function (choiceId) {
              var choice = findChoice(opt, choiceId);
              if (choice) {
                total += choice.delta;
              }
            });
          }
        });
        return total;
      }

      function getLineTotal(item, config, qty) {
        return getUnitPrice(item, config) * (qty || 1) + getAddonTotal(item, config);
      }

      function getSummaryParts(item, config) {
        var parts = [];
        (item.options || []).forEach(function (opt) {
          if (opt.type === 'multi') {
            (config[opt.id] || []).forEach(function (choiceId) {
              var choice = findChoice(opt, choiceId);
              if (choice) {
                parts.push('+' + choice.label);
              }
            });
          } else {
            var choice = findChoice(opt, config[opt.id]);
            if (choice) {
              parts.push(choice.label);
            }
          }
        });
        return parts;
      }

      // ---- Cart ----

      function getCartLines() {
        loadState();
        return cartLines.map(function (line) {
          var item = getItemById(line.itemId);
          if (!item) { return null; }
          var unitPrice = getUnitPrice(item, line.config);
          var addonTotal = getAddonTotal(item, line.config);
          return {
            key: line.key,
            itemId: item.id,
            item: item,
            config: line.config,
            qty: line.qty,
            unitPrice: unitPrice,
            addonTotal: addonTotal,
            lineTotal: unitPrice * line.qty + addonTotal,
            spec: getSummaryParts(item, line.config)
          };
        }).filter(Boolean);
      }

      function getCartItemCount() {
        var lines = getCartLines();
        var total = 0;
        lines.forEach(function (line) { total += line.qty; });
        return total;
      }

      function getInCartCount(itemId) {
        var lines = getCartLines();
        var total = 0;
        lines.forEach(function (line) {
          if (line.itemId === itemId) { total += line.qty; }
        });
        return total;
      }

      function getSubtotal() {
        var lines = getCartLines();
        var total = 0;
        lines.forEach(function (line) { total += line.lineTotal; });
        return total;
      }

      function getTax() {
        return Math.round(getSubtotal() * TAX_RATE);
      }

      function getTotal() {
        return getSubtotal() + getTax();
      }

      function getCartSummary() {
        var count = getCartItemCount();
        return {
          count: count,
          lineCount: getCartLines().length,
          subtotal: getSubtotal(),
          tax: getTax(),
          taxLabel: TAX_LABEL,
          total: getTotal()
        };
      }

      function addToCart(itemId, config, qty) {
        loadState();
        var item = getItemById(itemId);
        if (!item) { return; }
        var safeQty = Math.max(MIN_QTY, Math.min(MAX_QTY, qty || 1));
        cartLines.push({
          key: generateLineKey(),
          itemId: itemId,
          config: angular.copy(config || defaultConfig(item)),
          qty: safeQty
        });
        persistCart();
      }

      function updateLine(lineKey, config, qty) {
        loadState();
        for (var i = 0; i < cartLines.length; i++) {
          if (cartLines[i].key === lineKey) {
            cartLines[i].config = config;
            cartLines[i].qty = Math.max(MIN_QTY, Math.min(MAX_QTY, qty || 1));
            persistCart();
            return;
          }
        }
      }

      function removeLine(lineKey) {
        loadState();
        cartLines = cartLines.filter(function (line) { return line.key !== lineKey; });
        persistCart();
      }

      function clearCart() {
        loadState();
        cartLines = [];
        persistCart();
      }

      // ---- Orders ----

      function placeOrder(details) {
        loadState();
        var sid = currentStudentId();
        if (!sid || getCartItemCount() === 0) {
          return null;
        }
        var lines = getCartLines();
        var subtotal = getSubtotal();
        var tax = getTax();
        var items = lines.map(function (line) {
          return {
            key: line.key,
            itemId: line.itemId,
            name: line.item.name,
            emoji: line.item.emoji,
            category: line.item.category,
            spec: line.spec,
            qty: line.qty,
            unitPrice: line.unitPrice,
            addonTotal: line.addonTotal,
            lineTotal: line.lineTotal
          };
        });

        var order = {
          orderNo: generateOrderNumber(),
          studentId: sid,
          customerName: details.customerName,
          phone: details.phone,
          orderType: details.orderType,
          notes: details.notes || '',
          paymentMethod: details.paymentMethod,
          paymentDetail: details.paymentDetail || '',
          locationId: details.locationId || '',
          queuePosition: (typeof details.queuePosition === 'number') ? details.queuePosition : null,
          items: items,
          subtotal: subtotal,
          tax: tax,
          taxLabel: TAX_LABEL,
          total: subtotal + tax,
          placedAt: new Date(),
          status: 'Placed'
        };

        lastOrder = order;
        cartLines = [];
        persistCart();
        persistOrder();
        return order;
      }

      function getLastOrder() {
        loadState();
        return lastOrder;
      }

      function clearLastOrder() {
        loadState();
        lastOrder = null;
        try {
          var sid = currentStudentId();
          if (sid) {
            $window.sessionStorage.removeItem(ORDER_KEY + sid);
          }
        } catch (e) { /* noop */ }
      }

      function generateOrderNumber() {
        return 'FD-' + Math.floor(10000 + Math.random() * 90000);
      }

      function generateLineKey() {
        return Date.now().toString(36) + '-' + Math.floor(Math.random() * 100000).toString(36);
      }

      return {
        MIN_QTY: MIN_QTY,
        MAX_QTY: MAX_QTY,
        TAX_RATE: TAX_RATE,
        TAX_LABEL: TAX_LABEL,
        getMenu: getMenu,
        getCategories: getCategories,
        getItemById: getItemById,
        defaultConfig: defaultConfig,
        getUnitPrice: getUnitPrice,
        getAddonTotal: getAddonTotal,
        getLineTotal: getLineTotal,
        getSummaryParts: getSummaryParts,
        getCartLines: getCartLines,
        getCartItemCount: getCartItemCount,
        getInCartCount: getInCartCount,
        getSubtotal: getSubtotal,
        getTax: getTax,
        getTotal: getTotal,
        getCartSummary: getCartSummary,
        addToCart: addToCart,
        updateLine: updateLine,
        removeLine: removeLine,
        clearCart: clearCart,
        placeOrder: placeOrder,
        getLastOrder: getLastOrder,
        clearLastOrder: clearLastOrder
      };
    }
  ]);
})();