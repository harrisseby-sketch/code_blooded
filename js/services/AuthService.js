/* ============================================
   QueueSync - AuthService
   Manages student authentication state & ID validation,
   plus admin login via a special access code.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('AuthService', [
    '$window',
    function ($window) {
      var STORAGE_KEY = 'queueSync_studentId';
      var currentStudentId = null;

      // --- Admin credentials ---
      var ADMIN_STORAGE_KEY = 'queueSync_admin';
      var ADMIN_CODE = 'ADMIN@2026';
      var currentAdmin = false;

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
       * Logs in the student and stores ID in session.
       * An admin session is never active at the same time.
       */
      function login(studentId) {
        var cleanId = String(studentId).trim();
        currentStudentId = cleanId;
        try {
          $window.sessionStorage.setItem(STORAGE_KEY, cleanId);
        } catch (e) {
          console.warn('Could not write to sessionStorage:', e);
        }
        // Clear any admin session so the two roles stay fully separate.
        adminLogout();
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

      // ---- Admin session ----

      /**
       * Validates an admin access code (demo constant).
       * @returns {boolean}
       */
      function validateAdminCode(code) {
        return String(code || '').trim() === ADMIN_CODE;
      }

      /**
       * Logs the admin in if the code is correct.
       * A student session is never active at the same time.
       * @returns {boolean} true on success
       */
      function adminLogin(code) {
        if (!validateAdminCode(code)) {
          return false;
        }
        // Clear any student session so the two roles stay fully separate.
        currentStudentId = null;
        try {
          $window.sessionStorage.removeItem(STORAGE_KEY);
        } catch (e) {
          console.warn('Could not clear student session:', e);
        }
        currentAdmin = true;
        try {
          $window.sessionStorage.setItem(ADMIN_STORAGE_KEY, '1');
        } catch (e) {
          console.warn('Could not write admin session:', e);
        }
        return true;
      }

      /**
       * Logs the admin out.
       */
      function adminLogout() {
        currentAdmin = false;
        try {
          $window.sessionStorage.removeItem(ADMIN_STORAGE_KEY);
        } catch (e) {
          console.warn('Could not remove admin session:', e);
        }
      }

      /**
       * True while an admin session is active.
       */
      function isAdmin() {
        if (currentAdmin) {
          return true;
        }
        try {
          currentAdmin = !!$window.sessionStorage.getItem(ADMIN_STORAGE_KEY);
        } catch (e) {
          currentAdmin = false;
        }
        return currentAdmin;
      }

      return {
        validateStudentId: validateStudentId,
        isValidId: isValidId,
        login: login,
        logout: logout,
        getStudentId: getStudentId,
        isLoggedIn: isLoggedIn,
        validateAdminCode: validateAdminCode,
        adminLogin: adminLogin,
        adminLogout: adminLogout,
        isAdmin: isAdmin
      };
    }
  ]);
})();
