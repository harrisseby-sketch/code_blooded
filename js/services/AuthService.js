/* ============================================
   QueueSync - AuthService
   Manages student authentication state & ID validation
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('AuthService', [
    '$window',
    function ($window) {
      var STORAGE_KEY = 'queueSync_studentId';
      var currentStudentId = null;

      // Initialize from sessionStorage if available
      try {
        currentStudentId = $window.sessionStorage.getItem(STORAGE_KEY);
      } catch (e) {
        console.warn('SessionStorage is not accessible:', e);
      }

      /**
       * Validates a student ID according to hackathon rules:
       * 1. Must be exactly 5 digits.
       * 2. Must end with 23, 24, 25, or 26.
       * 
       * Valid:   12326, 54325, 98724, 11123
       * Invalid: 12345, 1222, 123267, abc26
       * 
       * @param {string} id - The raw student ID string.
       * @returns {string|null} Error string if invalid, or null if valid.
       */
      function validateStudentId(id) {
        if (!id || String(id).trim() === '') {
          return 'Enter a valid 5-digit student ID ending with 23, 24, 25, or 26.';
        }

        var cleanId = String(id).trim();

        // Must be exactly 5 digits and end with 23, 24, 25, or 26
        var validIdRegex = /^\d{3}(23|24|25|26)$/;

        if (!validIdRegex.test(cleanId)) {
          return 'Enter a valid 5-digit student ID ending with 23, 24, 25, or 26.';
        }

        return null; // Valid
      }

      /**
       * Checks if an ID is valid (returns boolean)
       */
      function isValidId(id) {
        return validateStudentId(id) === null;
      }

      /**
       * Logs in the student and stores ID in session
       */
      function login(studentId) {
        var cleanId = String(studentId).trim();
        currentStudentId = cleanId;
        try {
          $window.sessionStorage.setItem(STORAGE_KEY, cleanId);
        } catch (e) {
          console.warn('Could not write to sessionStorage:', e);
        }
        return true;
      }

      /**
       * Logs out the current student
       */
      function logout() {
        currentStudentId = null;
        try {
          $window.sessionStorage.removeItem(STORAGE_KEY);
        } catch (e) {
          console.warn('Could not remove from sessionStorage:', e);
        }
      }

      /**
       * Returns the current student ID, or null if unauthenticated
       */
      function getStudentId() {
        if (!currentStudentId) {
          try {
            currentStudentId = $window.sessionStorage.getItem(STORAGE_KEY);
          } catch (e) {
            currentStudentId = null;
          }
        }
        return currentStudentId;
      }

      /**
       * Returns true if user is logged in with a valid ID
       */
      function isLoggedIn() {
        var id = getStudentId();
        return id !== null && isValidId(id);
      }

      return {
        validateStudentId: validateStudentId,
        isValidId: isValidId,
        login: login,
        logout: logout,
        getStudentId: getStudentId,
        isLoggedIn: isLoggedIn
      };
    }
  ]);
})();
