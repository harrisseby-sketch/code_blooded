/* ============================================
   QueueSync - UserService
   User profile helpers: student ID accessor and
   the Recent Queues history list.

   Currently backed by sessionStorage so the demo
   works fully offline. Structured so the history
   can move to Firebase later, e.g.:
     users/{studentId}/history  (Firestore sub-collection)
   Each history entry adheres to the shared shape:
   {
     locationId: 'canteen' | 'photostat',
     joinedAt:  <Date>,
     servedAt:  <Date | null>,
     leftAt:    <Date | null>,
     status:    'Completed' | 'Left early',
     waitTimeMinutes: <number>
   }
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('UserService', [
    '$window',
    'AuthService',
    function ($window, AuthService) {

      var HISTORY_KEY_PREFIX = 'queueSync_history_';
      var MAX_HISTORY_ENTRIES = 50;

      // Cached per-student history plus the student it belongs to.
      var pendingStudentId = null; // studentId the cache was loaded for
      var cachedHistory = [];

      // Display label helper for location ids.
      var LOCATION_LABELS = {
        canteen: 'Canteen',
        photostat: 'Photostat Shop'
      };

      function getStudentId() {
        return AuthService.getStudentId();
      }

      /**
       * Lazily loads the history cache for the current student.
       * TODO(Firebase): replaced by onSnapshot on
       *   query(collection(db,'users',studentId,'history'), orderBy('joinedAt','desc'))
       */
      function ensureCacheLoaded() {
        var sid = getStudentId();
        if (!sid) {
          cachedHistory = [];
          pendingStudentId = null;
          return;
        }
        if (pendingStudentId === sid) {
          return; // already cached for this student
        }
        pendingStudentId = sid;
        cachedHistory = [];

        try {
          var raw = $window.sessionStorage.getItem(HISTORY_KEY_PREFIX + sid);
          if (raw) {
            var entries = JSON.parse(raw);
            if (angular.isArray(entries)) {
              cachedHistory = entries.map(function (entry) {
                // Re-hydrate timestamps into Date objects for display.
                if (entry.joinedAt) { entry.joinedAt = new Date(entry.joinedAt); }
                if (entry.servedAt) { entry.servedAt = new Date(entry.servedAt); }
                if (entry.leftAt)   { entry.leftAt   = new Date(entry.leftAt); }
                return entry;
              });
            }
          }
        } catch (e) {
          cachedHistory = [];
        }
      }

      function persist() {
        var sid = getStudentId();
        if (!sid) {
          return;
        }
        try {
          $window.sessionStorage.setItem(
            HISTORY_KEY_PREFIX + sid,
            JSON.stringify(cachedHistory)
          );
        } catch (e) {
          console.warn('Could not persist queue history:', e);
        }
      }

      /**
       * Adds a Recent Queues entry (newest first).
       * @param {Object} entry - see shape in file header.
       */
      function addQueueHistory(entry) {
        ensureCacheLoaded();
        if (!getStudentId()) {
          return null;
        }

        var normalized = angular.extend({}, entry);
        // Timestamps kept as Date instances; serialization handled on persist().
        cachedHistory.unshift(normalized);
        if (cachedHistory.length > MAX_HISTORY_ENTRIES) {
          cachedHistory.length = MAX_HISTORY_ENTRIES;
        }
        persist();
        return normalized;
      }

      /**
       * Returns all Recent Queues entries for the current student.
       */
      function getQueueHistory() {
        ensureCacheLoaded();
        return cachedHistory;
      }

      /**
       * Returns the most recent `limit` entries.
       */
      function getRecentQueueHistory(limit) {
        var all = getQueueHistory();
        return all.slice(0, limit || 5);
      }

      /**
       * Human-readable label for a locationId.
       */
      function getLocationLabel(locationId) {
        return LOCATION_LABELS[locationId] || locationId;
      }

      /**
       * Clears all history for the current student (helper / demo reset).
       */
      function clearHistory() {
        ensureCacheLoaded();
        cachedHistory = [];
        persist();
      }

      return {
        getStudentId: getStudentId,
        addQueueHistory: addQueueHistory,
        getQueueHistory: getQueueHistory,
        getRecentQueueHistory: getRecentQueueHistory,
        getLocationLabel: getLocationLabel,
        clearHistory: clearHistory
      };
    }
  ]);
})();