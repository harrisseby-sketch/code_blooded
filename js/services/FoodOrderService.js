/* ============================================
   QueueSync - FoodOrderService (DB-backed)
   Campus food ordering: menu catalog (Biriyani,
   Alfam, Meals, Chapathi), item customizations,
   shopping cart, pricing & checkout.

   STORAGE: the virtual live DatabaseService
   (student_db.carts/cart_lines/orders/order_items
   linked by FK to admin_db.menu_items stock).
   Checkout is one atomic DB transaction over ALL
   cart lines, so N items in -> N items ordered.

   Pricing model per item:
     - radio options apply a PER-UNIT delta
     - multi options apply a ONE-TIME per-line delta
     - lineTotal = qty x unitPrice + addonTotal
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('FoodOrderService', [
    '$window',
    '$rootScope',
    'AuthService',
    'DatabaseService',
    function ($window, $rootScope, AuthService, DatabaseService) {

      var LEGACY_CART_KEY = 'queueSync_foodCart_';
      var LEGACY_ORDER_KEY = 'queueSync_foodOrder_';
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

      function currentStudentId() {
        return AuthService.getStudentId();
      }

      // One-time migration of the legacy per-tab sessionStorage cart into
      // the shared DB so existing demo carts are not lost on upgrade.
      var migratedFor = {};
      function migrateLegacyOnce() {
        var sid = currentStudentId();
        if (!sid || migratedFor[sid]) { return; }
        migratedFor[sid] = true;
        try {
          if (DatabaseService.getCartLines(sid).length > 0) { return; }
          var raw = $window.sessionStorage.getItem(LEGACY_CART_KEY + sid);
          if (!raw) { return; }
          var parsed = JSON.parse(raw);
          if (!parsed || !angular.isArray(parsed) || !parsed.length) { return; }
          parsed.forEach(function (line) {
            try {
              if (line && line.itemId) {
                DatabaseService.addCartLine(sid, line.itemId, line.config, line.qty);
              }
            } catch (e) { /* skip bad legacy line */ }
          });
          $window.sessionStorage.removeItem(LEGACY_CART_KEY + sid);
        } catch (e) { /* noop */ }
      }

      // ---- Menu helpers (availability + stock merged live from admin_db) ----

      function stockMap() {
        var map = {};
        try {
          DatabaseService.getMenuItems().forEach(function (m) { map[m.id] = m; });
        } catch (e) { /* DB unavailable -> treat as fully available */ }
        return map;
      }

      function getMenu() {
        migrateLegacyOnce();
        var stocks = stockMap();
        return MENU.map(function (item) {
          var copy = angular.copy(item);
          var s = stocks[item.id];
          copy.stockQty = s ? s.stock_qty : 999;
          // Sold out when admin marks unavailable OR stock hits 0.
          copy.available = s ? (s.available && s.stock_qty > 0) : true;
          if (s) { copy.basePrice = s.base_price; }
          return copy;
        });
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
        // Enriched (with live availability) when possible.
        var menu = getMenu();
        for (var i = 0; i < menu.length; i++) {
          if (menu[i].id === itemId) { return menu[i]; }
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

      // ---- Cart (DB-backed; always re-read fresh, never stale cache) ----

      function enrichLine(dbLine) {
        var item = getItemById(dbLine.item_id);
        if (!item) { return null; }
        var unitPrice = getUnitPrice(item, dbLine.config);
        var addonTotal = getAddonTotal(item, dbLine.config);
        return {
          key: dbLine.id,
          itemId: item.id,
          item: item,
          config: angular.copy(dbLine.config),
          qty: dbLine.qty,
          unitPrice: unitPrice,
          addonTotal: addonTotal,
          lineTotal: unitPrice * dbLine.qty + addonTotal,
          spec: getSummaryParts(item, dbLine.config)
        };
      }

      function getCartLines() {
        migrateLegacyOnce();
        var sid = currentStudentId();
        if (!sid) { return []; }
        return DatabaseService.getCartLines(sid).map(enrichLine).filter(Boolean);
      }

      function getCartItemCount() {
        var total = 0;
        getCartLines().forEach(function (line) { total += line.qty; });
        return total;
      }

      function getInCartCount(itemId) {
        var total = 0;
        getCartLines().forEach(function (line) {
          if (line.itemId === itemId) { total += line.qty; }
        });
        return total;
      }

      function getSubtotal() {
        var total = 0;
        getCartLines().forEach(function (line) { total += line.lineTotal; });
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

      function notifyCart() {
        $rootScope.$broadcast('food:cartUpdated');
      }

      function addToCart(itemId, config, qty) {
        var sid = currentStudentId();
        if (!sid) { return; }
        var item = getItemById(itemId);
        if (!item || !item.available) { return; }
        var safeQty = Math.max(MIN_QTY, Math.min(MAX_QTY, qty || 1));
        DatabaseService.addCartLine(sid, itemId, angular.copy(config || defaultConfig(item)), safeQty);
        notifyCart();
      }

      function updateLine(lineKey, config, qty) {
        var sid = currentStudentId();
        if (!sid) { return; }
        DatabaseService.updateCartLine(sid, lineKey, config, qty);
        notifyCart();
      }

      function removeLine(lineKey) {
        var sid = currentStudentId();
        if (!sid) { return; }
        DatabaseService.removeCartLine(sid, lineKey);
        notifyCart();
      }

      function clearCart() {
        var sid = currentStudentId();
        if (!sid) { return; }
        DatabaseService.clearCart(sid);
        notifyCart();
      }

      // ---- Orders (atomic: every line becomes an order_item) ----

      function priceView(v) {
        var item = getItemById(v.itemId);
        var unitPrice = getUnitPrice(item, v.config);
        var addonTotal = getAddonTotal(item, v.config);
        return {
          name: item.name,
          emoji: item.emoji,
          spec: getSummaryParts(item, v.config),
          unitPrice: unitPrice,
          addonTotal: addonTotal,
          lineTotal: unitPrice * v.qty + addonTotal
        };
      }

      function placeOrder(details) {
        var sid = currentStudentId();
        if (!sid || getCartItemCount() === 0) {
          return null;
        }
        var result = DatabaseService.checkout(sid, {
          orderType: details.orderType,
          notes: details.notes || '',
          paymentMethod: details.paymentMethod,
          paymentDetail: details.paymentDetail || ''
        }, priceView);
        if (!result) { return null; }
        notifyCart();
        var o = result.order;
        return {
          orderNo: o.id,
          studentId: sid,
          customerName: details.customerName,
          phone: details.phone,
          orderType: o.order_type,
          notes: o.notes,
          paymentMethod: o.payment_method,
          paymentDetail: o.payment_detail,
          locationId: details.locationId || '',
          queuePosition: (typeof details.queuePosition === 'number') ? details.queuePosition : null,
          items: result.items.map(function (it) {
            return {
              key: it.id, itemId: it.item_id, name: it.name, emoji: it.emoji,
              category: '', spec: it.spec, qty: it.qty,
              unitPrice: it.unit_price, addonTotal: it.addon_total, lineTotal: it.line_total
            };
          }),
          subtotal: o.subtotal,
          tax: o.tax,
          taxLabel: o.tax_label,
          total: o.total,
          placedAt: new Date(o.placed_at),
          status: o.status
        };
      }

      function getLastOrder() {
        var sid = currentStudentId();
        if (!sid) { return null; }
        var o = DatabaseService.getLastOrder(sid);
        if (!o) {
          // Legacy fallback: single last order stored per-tab pre-upgrade.
          try {
            var raw = $window.sessionStorage.getItem(LEGACY_ORDER_KEY + sid);
            if (raw) {
              var legacy = JSON.parse(raw);
              if (legacy && legacy.orderNo) { return legacy; }
            }
          } catch (e) { /* noop */ }
          return null;
        }
        return {
          orderNo: o.id,
          studentId: sid,
          orderType: o.orderType,
          notes: '',
          paymentMethod: 'online',
          paymentDetail: o.paymentDetail,
          items: o.items,
          subtotal: o.subtotal,
          tax: o.tax,
          taxLabel: o.taxLabel,
          total: o.total,
          placedAt: new Date(o.placedAt),
          status: o.status
        };
      }

      function clearLastOrder() {
        // No-op kept for API compatibility: history now lives in the DB
        // (admin dashboard reads the full orders table).
      }

      // Live cross-tab sync: another tab (student checkout / admin restock)
      // -> refresh every listener via the canonical cart event + digest.
      DatabaseService.subscribe('cart_lines', function () { notifyCart(); });
      DatabaseService.subscribe('menu_items', function () {
        $rootScope.$broadcast('food:menuUpdated');
      });
      try {
        $window.addEventListener('storage', function () {
          notifyCart();
          $rootScope.$broadcast('food:menuUpdated');
        });
      } catch (e) { /* noop */ }

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
