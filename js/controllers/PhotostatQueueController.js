/* ============================================
   QueueSync - PhotostatQueueController
   Detailed queue controls & live stats for Photostat.
   Adds a service flow (Print / Photostat): choose a
   service, enter page count, pay, and the user is
   added to the queue automatically with the option
   to exit anytime.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').controller('PhotostatQueueController', [
    '$scope',
    '$location',
    '$interval',
    '$timeout',
    '$window',
    '$q',
    'AuthService',
    'QueueService',
    'FirestoreService',
    function ($scope, $location, $interval, $timeout, $window, $q, AuthService, QueueService, FirestoreService) {

      // Ensure user is authenticated
      if (!AuthService.isLoggedIn()) {
        $location.path('/login');
        return;
      }

      $scope.locationId = 'photostat';
      $scope.studentId = AuthService.getStudentId();

      $scope.queue = QueueService.getQueue('photostat');
      $scope.queueInfo = QueueService.getQueueInfo('photostat');
      $scope.userStatus = QueueService.getUserStatus('photostat');
      $scope.myStatus = null;
      $scope.isUpdating = false;
      $scope.simSpeed = QueueService.getSimulationSpeed();

      // Live status report options for users currently in the queue.
      $scope.liveStatusOptions = [
        { value: 'fast',   label: 'Moving fast' },
        { value: 'normal', label: 'Normal' },
        { value: 'slow',   label: 'Moving slow' }
      ];

      // ---- Photostat service flow state ----

      $scope.photostatServices = [
        { id: 'print',     label: 'Print',     emoji: '🖨️', pricePerPage: 5 },
        { id: 'photostat', label: 'Photostat', emoji: '📄', pricePerPage: 2 }
      ];

      $scope.paymentMethods = [
        { id: 'online', label: 'Online', emoji: '📱', hint: 'Pay now online' }
      ];

      $scope.onlineMethods = [
        { id: 'upi',  label: 'UPI' },
        { id: 'card', label: 'Card' }
      ];

      var JOB_KEY = 'queueSync_photostatJob_';

      $scope.photostatService = null;
      $scope.jobPages = null;
      $scope.jobCopies = 1;
      $scope.jobColor = 'bw';
      $scope.jobSides = 'single';
      $scope.jobPayment = 'online';
      $scope.jobPaymentOnline = 'upi';
      $scope.photostatError = '';
      $scope.isPaying = false;
      $scope.job = null;
      $scope.uploadedFiles = [];

      // Print options shown on the admin "Now Serving" card.
      $scope.jobColors = [
        { id: 'bw',    label: 'B/W' },
        { id: 'color', label: 'Colour' }
      ];
      $scope.jobSidesOptions = [
        { id: 'single', label: 'Single-sided' },
        { id: 'double', label: 'Double-sided' }
      ];

      function persistPhotostatJob() {
        try {
          $window.sessionStorage.setItem(JOB_KEY + $scope.studentId, JSON.stringify($scope.job));
        } catch (e) { /* noop */ }
      }

      function restorePhotostatJob() {
        try {
          var raw = $window.sessionStorage.getItem(JOB_KEY + $scope.studentId);
          $scope.job = raw ? JSON.parse(raw) : null;
        } catch (e) {
          $scope.job = null;
        }
      }

      restorePhotostatJob();

      $scope.startPhotostatJob = function (serviceId) {
        if ($scope.userStatus.joined) {
          return;
        }
        for (var i = 0; i < $scope.photostatServices.length; i++) {
          if ($scope.photostatServices[i].id === serviceId) {
            $scope.photostatService = $scope.photostatServices[i];
            break;
          }
        }
        $scope.jobPages = 1;
        $scope.jobCopies = 1;
        $scope.jobColor = 'bw';
        $scope.jobSides = 'single';
        $scope.jobPayment = 'online';
        $scope.jobPaymentOnline = 'upi';
        $scope.photostatError = '';
        $scope.uploadedFiles = [];
      };

      $scope.cancelPhotostatJob = function () {
        $scope.photostatService = null;
        $scope.jobPages = null;
        $scope.jobCopies = 1;
        $scope.jobColor = 'bw';
        $scope.jobSides = 'single';
        $scope.photostatError = '';
        $scope.uploadedFiles = [];
      };

      $scope.photostatCost = function () {
        if (!$scope.photostatService) {
          return 0;
        }
        var pages = parseInt($scope.jobPages, 10);
        if (!pages || pages < 1) {
          return 0;
        }
        var copies = parseInt($scope.jobCopies, 10);
        if (!copies || copies < 1) {
          copies = 1;
        }
        return pages * copies * $scope.photostatService.pricePerPage;
      };

      $scope.onFilesSelected = function (files) {
        // Keep the raw File objects (they carry name/size AND the bytes needed
        // for the Firebase Storage upload below).
        $scope.uploadedFiles = Array.prototype.slice.call(files || []);
        $scope.photostatError = '';
        if (!$scope.$$phase) {
          $scope.$apply();
        }
      };

      $scope.formatFileSize = function (bytes) {
        if (!bytes && bytes !== 0) { return ''; }
        if (bytes < 1024) { return bytes + ' B'; }
        if (bytes < 1048576) { return (bytes / 1024).toFixed(0) + ' KB'; }
        return (bytes / 1048576).toFixed(1) + ' MB';
      };

      $scope.canSubmitPhotostatJob = function () {
        if (!$scope.photostatService) {
          return false;
        }
        var pages = parseInt($scope.jobPages, 10);
        if (!pages || pages < 1) {
          return false;
        }
        if ($scope.photostatService.id === 'print' && (!$scope.uploadedFiles || $scope.uploadedFiles.length === 0)) {
          return false;
        }
        return true;
      };

      $scope.payPhotostatJob = function () {
        if ($scope.isPaying || $scope.userStatus.joined || !$scope.photostatService) {
          return;
        }

        var pages = parseInt($scope.jobPages, 10);
        if (!pages || pages < 1) {
          $scope.photostatError = 'Enter a valid number of pages.';
          return;
        }
        if ($scope.photostatService.id === 'print' && (!$scope.uploadedFiles || $scope.uploadedFiles.length === 0)) {
          $scope.photostatError = 'Upload at least one file to print.';
          return;
        }
        $scope.photostatError = '';
        $scope.isPaying = true;

        var svc = $scope.photostatService;
        var copies = parseInt($scope.jobCopies, 10);
        if (!copies || copies < 1) { copies = 1; }
        var amount = pages * copies * svc.pricePerPage;
        var paymentLabel = 'Online (' + ($scope.jobPaymentOnline === 'card' ? 'Card' : 'UPI') + ')';

        // Upload print files to Firebase Storage first (best-effort). When
        // Storage is unavailable the upload resolves [] and we fall back to
        // recording the file name/size only, exactly as before.
        var uploadPromise = svc.id === 'print' && $scope.uploadedFiles && $scope.uploadedFiles.length
          ? FirestoreService.uploadFiles($scope.uploadedFiles)
          : $q.resolve([]);

        uploadPromise.then(function (uploaded) {
          var files = uploaded && uploaded.length
            ? uploaded
            : $scope.uploadedFiles.map(function (f) { return { name: f.name, size: f.size }; });

          // Simulate a short payment-processing delay before auto-joining.
          $timeout(function () {
            $scope.job = {
              serviceId: svc.id,
              serviceLabel: svc.label,
              pages: pages,
              copies: copies,
              color: $scope.jobColor,
              sides: $scope.jobSides,
              files: files,
              amount: amount,
              paymentMethod: $scope.jobPayment,
              paymentLabel: paymentLabel,
              orderNo: 'PS-' + Math.floor(10000 + Math.random() * 90000),
              paidAt: new Date()
            };
            persistPhotostatJob();

            QueueService.joinQueue('photostat', $scope.studentId)
              .then(function () {
                // Attach the job payload to the request doc so the admin
                // "Now Serving" card shows file name, copies, B/W|Colour and
                // single/double-side live across every device.
                return QueueService.setRequestPayload('photostat', $scope.job);
              })
              .then(function () {
                refresh();
                QueueService.showToast(
                  'Payment done \u2014 ' + $scope.job.serviceLabel + ' Job ' + $scope.job.orderNo + ' placed. You joined the queue!',
                  'success'
                );
              })
              .catch(function (err) {
                console.error('Auto-join failed:', err);
                QueueService.showToast('Payment done, but we could not join the queue. Please try again.', 'warning');
              })
              .finally(function () {
                $scope.isPaying = false;
              });
          }, 900);
        });
      };

      $scope.confirmedJob = function () {
        return $scope.job || {
          serviceLabel: 'Printing / Photocopy',
          pages: '\u2014',
          copies: '\u2014',
          color: '\u2014',
          sides: '\u2014',
          files: [],
          amount: '\u2014',
          paymentLabel: '\u2014',
          orderNo: '\u2014'
        };
      };

      /**
       * Refreshes everything bound to this page (queue, info, positions).
       */
      function refresh() {
        $scope.queue = QueueService.getQueue('photostat');
        $scope.queueInfo = QueueService.getQueueInfo('photostat');
        $scope.userStatus = QueueService.getUserStatus('photostat');
        $scope.simSpeed = QueueService.getSimulationSpeed();

        // Pre-select the user's current report (if any).
        if ($scope.queue) {
          $scope.myStatus = null;
          if ($scope.userStatus.joined) {
            for (var i = 0; i < $scope.queue.liveStatusReports.length; i++) {
              if ($scope.queue.liveStatusReports[i].studentId === $scope.studentId) {
                $scope.myStatus = $scope.queue.liveStatusReports[i].status;
                break;
              }
            }
          }
        }
      }

      refresh();

      /**
       * Leave Photostat Shop Queue (also clears the confirmed job).
       */
      $scope.leaveQueue = function () {
        if ($scope.isUpdating || !$scope.userStatus.joined) {
          return;
        }

        $scope.isUpdating = true;
        QueueService.leaveQueue('photostat', $scope.studentId)
          .then(function () {
            $scope.job = null;
            try {
              $window.sessionStorage.removeItem(JOB_KEY + $scope.studentId);
            } catch (e) { /* noop */ }
            refresh();
          })
          .catch(function (err) {
            console.error('Failed to leave queue:', err);
          })
          .finally(function () {
            $scope.isUpdating = false;
          });
      };

      /**
       * Records the current user's live-status report for this queue.
       */
      $scope.setLiveStatus = function (value) {
        if (!$scope.userStatus.joined) {
          return;
        }
        QueueService.updateLiveStatus('photostat', $scope.studentId, value)
          .then(function () {
            $scope.myStatus = value;
            refresh();
          })
          .catch(function (err) {
            console.error('Failed to update live status:', err);
          });
      };

      /**
       * Demo helper: cycles simulation speed (1x, 30x, 120x).
       */
      $scope.cycleSimSpeed = function () {
        var next = $scope.simSpeed >= 120 ? 1 : ($scope.simSpeed * 30);
        QueueService.setSimulationSpeed(next);
        refresh();
      };

      /**
       * Return to home view
       */
      $scope.goBack = function () {
        $location.path('/home');
      };

      $scope.goToProfile = function () {
        $location.path('/profile');
      };

      // Periodic refresh keeps "Right now" advice + positions live.
      var interval = $interval(refresh, 15000);

      // Real-time update listeners
      var unbindUpdated = $scope.$on('queue:updated', function (event, data) {
        if (data.locationId === 'photostat') {
          refresh();
        }
      });
      var unbindLive = $scope.$on('queue:liveStatus', function (event, data) {
        if (data.locationId === 'photostat') {
          refresh();
        }
      });
      var unbindServed = $scope.$on('queue:served', function (event, data) {
        if (data.locationId === 'photostat') {
          refresh();
        }
      });
      var unbindNext = $scope.$on('queue:next', function () {
        refresh();
      });

      $scope.$on('$destroy', function () {
        if (interval) { $interval.cancel(interval); }
        if (unbindUpdated) { unbindUpdated(); }
        if (unbindLive) { unbindLive(); }
        if (unbindServed) { unbindServed(); }
        if (unbindNext) { unbindNext(); }
      });
    }
  ]);
})();