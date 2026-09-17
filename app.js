/* ============================================
   QueueSync - AngularJS Application
   Login Controller & Validation Logic
   ============================================ */

(function () {
  'use strict';

  // --- Configuration ---
  // Easily adjustable constants
  var CONFIG = {
    MIN_ID_LENGTH: 4,
    SUBMIT_DELAY_MS: 1500, // Simulated login delay (ms)
  };

  // --- Firebase Integration Point ---
  // To integrate Firebase later, uncomment and configure:
  //
  // import { initializeApp } from 'firebase/app';
  // import { getFirestore, collection, doc, getDoc, setDoc } from 'firebase/firestore';
  //
  // const firebaseConfig = {
  //   apiKey: 'YOUR_API_KEY',
  //   authDomain: 'YOUR_PROJECT.firebaseapp.com',
  //   projectId: 'YOUR_PROJECT_ID',
  //   storageBucket: 'YOUR_PROJECT.appspot.com',
  //   messagingSenderId: 'YOUR_SENDER_ID',
  //   appId: 'YOUR_APP_ID'
  // };
  //
  // const app = initializeApp(firebaseConfig);
  // const db = getFirestore(app);

  // --- AngularJS Module ---
  var app = angular.module('queueSyncApp', []);

  // --- Login Controller ---
  app.controller('LoginController', [
    '$scope',
    '$timeout',
    function ($scope, $timeout) {
      // --- Scope Variables ---
      $scope.studentId = '';
      $scope.errorMessage = '';
      $scope.isSubmitting = false;
      $scope.loggedIn = false;

      /**
       * Validates the student ID.
       * @param {string} id - The raw student ID input.
       * @returns {string|null} Error message if invalid, null if valid.
       */
      function validateStudentId(id) {
        if (!id || id.trim() === '') {
          return 'Please enter your student ID.';
        }

        // Strip whitespace
        var cleanId = id.trim();

        // Check if numeric only (digits only)
        if (!/^\d+$/.test(cleanId)) {
          return 'Student ID must contain only numbers.';
        }

        // Check minimum length
        if (cleanId.length < CONFIG.MIN_ID_LENGTH) {
          return 'Please enter a valid student ID (at least ' + CONFIG.MIN_ID_LENGTH + ' digits).';
        }

        return null; // Valid
      }

      /**
       * Handles form submission.
       * Validates input, simulates login, and logs result.
       */
      $scope.handleLogin = function () {
        // Clear previous errors
        $scope.errorMessage = '';

        // Prevent multiple rapid submissions
        if ($scope.isSubmitting) {
          return;
        }

        // Validate
        var error = validateStudentId($scope.studentId);
        if (error) {
          $scope.errorMessage = error;
          return;
        }

        // Trim the ID
        var cleanId = $scope.studentId.trim();

        // Mark as submitting (disables button, shows spinner)
        $scope.isSubmitting = true;

        // --- Simulated Login ---
        // Replace this block with real Firebase / backend call:
        //
        // const studentRef = doc(db, 'students', cleanId);
        // const studentSnap = await getDoc(studentRef);
        // if (studentSnap.exists()) {
        //   console.log('Student found:', studentSnap.data());
        // } else {
        //   await setDoc(studentRef, { id: cleanId, createdAt: new Date() });
        //   console.log('New student created');
        // }

        $timeout(function () {
          $scope.isSubmitting = false;
          $scope.loggedIn = true;

          console.log('QueueSync: Logged in as', cleanId);

          // Optional: Navigate to home route
          // $location.path('/home');
        }, CONFIG.SUBMIT_DELAY_MS);
      };

      // Watch input changes to clear errors
      $scope.$watch('studentId', function (newVal, oldVal) {
        if (newVal !== oldVal && $scope.errorMessage) {
          $scope.errorMessage = '';
        }
      });
    },
  ]);
})();
