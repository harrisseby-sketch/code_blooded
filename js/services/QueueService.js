/* ============================================
   QueueSync - QueueService
   Manages campus queue states, wait-time estimation,
   simulated network latency, and Firebase readiness
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('QueueService', [
    '$q',
    '$timeout',
    '$rootScope',
    function ($q, $timeout, $rootScope) {

      // --- In-Memory Queue Store ---
      // Real-world starting estimates for campus locations
      var queues = {
        canteen: {
          id: 'canteen',
          title: 'Canteen',
          fullTitle: 'Canteen Queue',
          description: 'Campus cafeteria, meal tokens & snack counters',
          badge: 'Dining Hall',
          iconType: 'canteen',
          count: 14,
          avgTimePerPerson: 0.75, // ~45 seconds per person
          waitTime: 11, // in minutes
          themeColor: '#f59e0b',
          themeBg: 'rgba(245, 158, 11, 0.1)',
          statusTag: 'Moderate Line'
        },
        photostat: {
          id: 'photostat',
          title: 'Photostat Shop',
          fullTitle: 'Photostat Shop Queue',
          description: 'Document printing, photocopy, spiral binding & scanning',
          badge: 'Library Annex',
          iconType: 'photostat',
          count: 6,
          avgTimePerPerson: 1.5, // 1.5 minutes (90s) per person
          waitTime: 9, // in minutes
          themeColor: '#6366f1',
          themeBg: 'rgba(99, 102, 241, 0.1)',
          statusTag: 'Fast Moving'
        }
      };

      // Track user's joined status per queue
      var userQueueStatus = {
        canteen: { joined: false, position: null, joinedAt: null },
        photostat: { joined: false, position: null, joinedAt: null }
      };

      // Active Toast Notification State
      var toastState = {
        visible: false,
        message: '',
        type: 'success', // 'success', 'info', 'warning'
        timer: null
      };

      /**
       * Calculates estimated wait time in minutes for a given queue
       */
      function calculateWaitTime(queue) {
        if (queue.count <= 0) {
          return 0;
        }
        return Math.ceil(queue.count * queue.avgTimePerPerson);
      }

      /**
       * Updates status tag based on wait time
       */
      function updateStatusTag(queue) {
        var wait = queue.waitTime;
        if (wait === 0) {
          queue.statusTag = 'Empty Queue';
        } else if (wait <= 5) {
          queue.statusTag = 'Quick (< 5 mins)';
        } else if (wait <= 12) {
          queue.statusTag = 'Moderate Line';
        } else {
          queue.statusTag = 'High Volume';
        }
      }

      // Initial calculation
      Object.keys(queues).forEach(function (key) {
        queues[key].waitTime = calculateWaitTime(queues[key]);
        updateStatusTag(queues[key]);
      });

      /**
       * Show toast message
       */
      function showToast(message, type) {
        if (toastState.timer) {
          $timeout.cancel(toastState.timer);
        }
        toastState.message = message;
        toastState.type = type || 'success';
        toastState.visible = true;

        toastState.timer = $timeout(function () {
          toastState.visible = false;
        }, 3500);
      }

      function hideToast() {
        if (toastState.timer) {
          $timeout.cancel(toastState.timer);
        }
        toastState.visible = false;
      }

      /**
       * Returns all queues as an array or object
       */
      function getQueues() {
        return queues;
      }

      /**
       * Returns single queue by location ID
       */
      function getQueue(locationId) {
        return queues[locationId] || null;
      }

      /**
       * Returns user status for a specific queue
       */
      function getUserStatus(locationId) {
        return userQueueStatus[locationId] || { joined: false, position: null };
      }

      /**
       * Joins a queue (simulated network latency, ready for Firebase)
       * @param {string} locationId - 'canteen' | 'photostat'
       * @param {string} studentId - Student ID of current user
       * @returns {Promise}
       */
      function joinQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = queues[locationId];

        if (!queue) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        // Simulate 400ms network delay (mimicking Firebase transaction)
        $timeout(function () {
          // Increment count
          queue.count += 1;
          queue.waitTime = calculateWaitTime(queue);
          updateStatusTag(queue);

          // Update user membership
          userQueueStatus[locationId].joined = true;
          userQueueStatus[locationId].position = queue.count;
          userQueueStatus[locationId].joinedAt = new Date();

          // Show confirmation toast
          showToast('You joined the ' + queue.title + ' queue.', 'success');

          // Notify any listening controllers
          $rootScope.$broadcast('queue:updated', {
            locationId: locationId,
            action: 'join',
            queue: queue
          });

          // ====================================================
          // --- Firebase Firestore Real-Time Integration Point ---
          // ====================================================
          // To persist to Firebase in the future, uncomment:
          //
          // import { doc, runTransaction } from 'firebase/firestore';
          // const queueRef = doc(db, 'queues', locationId);
          // await runTransaction(db, async (transaction) => {
          //   const qDoc = await transaction.get(queueRef);
          //   if (!qDoc.exists()) throw "Queue doc does not exist!";
          //   const newCount = (qDoc.data().count || 0) + 1;
          //   transaction.update(queueRef, {
          //     count: newCount,
          //     lastUpdated: new Date()
          //   });
          //   transaction.set(doc(db, 'queues', locationId, 'members', studentId), {
          //     studentId: studentId,
          //     position: newCount,
          //     joinedAt: new Date()
          //   });
          // });

          deferred.resolve({
            queue: queue,
            status: userQueueStatus[locationId]
          });
        }, 400);

        return deferred.promise;
      }

      /**
       * Leaves a queue (simulated network latency, ready for Firebase)
       * @param {string} locationId - 'canteen' | 'photostat'
       * @param {string} studentId - Student ID of current user
       * @returns {Promise}
       */
      function leaveQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = queues[locationId];

        if (!queue) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        // Simulate 400ms network delay
        $timeout(function () {
          // Decrement count, ensuring it never drops below 0
          queue.count = Math.max(0, queue.count - 1);
          queue.waitTime = calculateWaitTime(queue);
          updateStatusTag(queue);

          // Update user membership
          userQueueStatus[locationId].joined = false;
          userQueueStatus[locationId].position = null;
          userQueueStatus[locationId].joinedAt = null;

          // Show confirmation toast
          showToast('You left the ' + queue.title + ' queue.', 'info');

          // Notify any listening controllers
          $rootScope.$broadcast('queue:updated', {
            locationId: locationId,
            action: 'leave',
            queue: queue
          });

          // ====================================================
          // --- Firebase Firestore Real-Time Integration Point ---
          // ====================================================
          // To delete member and decrement in Firebase:
          //
          // const queueRef = doc(db, 'queues', locationId);
          // await runTransaction(db, async (transaction) => {
          //   const qDoc = await transaction.get(queueRef);
          //   const currentCount = qDoc.data().count || 0;
          //   transaction.update(queueRef, {
          //     count: Math.max(0, currentCount - 1),
          //     lastUpdated: new Date()
          //   });
          //   transaction.delete(doc(db, 'queues', locationId, 'members', studentId));
          // });

          deferred.resolve({
            queue: queue,
            status: userQueueStatus[locationId]
          });
        }, 400);

        return deferred.promise;
      }

      return {
        getQueues: getQueues,
        getQueue: getQueue,
        getUserStatus: getUserStatus,
        calculateWaitTime: calculateWaitTime,
        joinQueue: joinQueue,
        leaveQueue: leaveQueue,
        toastState: toastState,
        showToast: showToast,
        hideToast: hideToast
      };
    }
  ]);
})();
