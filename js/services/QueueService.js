/* ============================================
   QueueSync - QueueService
   Manages campus queue states, busyness levels,
   predictive wait times, best-time recommendations,
   live status reports, dynamic positions, the current
   live queue data and the simulated service loop.

   Two execution modes:
     CLOUD (Firestore) - the app subscribes to the live
       `queues/{locationId}/members` collection via
       onSnapshot. Joins / leaves / serves / payloads are
       written through FirestoreService transactions, and
       every connected device (students + admin) updates
       in real time through the snapshots.
     DEMO - fully in-memory (as before); a $timeout service
       loop pops the front member locally. Used when the
       Firebase SDK/config is unavailable.
   ============================================ */

(function () {
  'use strict';

  angular.module('queueSyncApp').factory('QueueService', [
    '$q',
    '$timeout',
    '$rootScope',
    '$window',
    'AuthService',
    'UserService',
    'DatabaseService',
    'FirestoreService',
    function ($q, $timeout, $rootScope, $window, AuthService, UserService, DatabaseService, FirestoreService) {

      // ============================================
      //        CONFIGURATION (per location)
      // ============================================
      var SIMULATION_SPEED = 1;

      var DEFAULT_BUSYNESS_THRESHOLDS = [
        { max: 5,  level: 'Low' },      // 0-5
        { max: 12, level: 'Medium' },   // 6-12
        { max: Infinity, level: 'High' }// 13+
      ];

      var LOCATION_CONFIG = {
        canteen: {
          timePerPerson: 1, // 1 minute per person (per spec)
          busynessThresholds: DEFAULT_BUSYNESS_THRESHOLDS,
          rushWindows: [
            { start: '12:30', end: '14:00' },
            { start: '18:30', end: '20:00' }
          ],
          bestWindows: [
            { start: '10:00', end: '12:00' },
            { start: '15:00', end: '17:00' }
          ]
        },
        photostat: {
          timePerPerson: 3, // 3 minutes per person (per spec)
          busynessThresholds: DEFAULT_BUSYNESS_THRESHOLDS,
          rushWindows: [
            { start: '09:00', end: '11:00' },
            { start: '16:00', end: '17:30' }
          ],
          bestWindows: [
            { start: '12:00', end: '15:00' }
          ]
        }
      };

      // ============================================
      //          IN-MEMORY QUEUE STORE (mirror)
      // ============================================
      // In cloud mode this is the LIVE mirror of the Firestore members
      // collection (updated by onSnapshot). In demo mode it is the source
      // of truth. `members` is an ordered FIFO list (oldest first).
      var queues = {
        canteen: {
          id: 'canteen',
          title: 'Canteen',
          fullTitle: 'Canteen Queue',
          description: 'Campus cafeteria, meal tokens & snack counters',
          badge: 'Dining Hall',
          iconType: 'canteen',
          themeColor: '#f59e0b',
          themeBg: 'rgba(245, 158, 11, 0.1)',
          timePerPerson: LOCATION_CONFIG.canteen.timePerPerson,
          members: [],              // FIFO: [{ studentId, joinedAt, request? }]
          liveStatusReports: [],    // [{ studentId, status, at }]
          serveTimer: null,
          seeded: false
        },
        photostat: {
          id: 'photostat',
          title: 'Photostat Shop',
          fullTitle: 'Photostat Shop Queue',
          description: 'Document printing, photocopy, spiral binding & scanning',
          badge: 'Library Annex',
          iconType: 'photostat',
          themeColor: '#6366f1',
          themeBg: 'rgba(99, 102, 241, 0.1)',
          timePerPerson: LOCATION_CONFIG.photostat.timePerPerson,
          members: [],
          liveStatusReports: [],
          serveTimer: null,
          seeded: false
        }
      };

      // The current user's membership per location.
      var userQueueStatus = {
        canteen: { joined: false, position: null, peopleAhead: null, minutesUntilTurn: null, served: false, nextNotified: false, joinPosition: null, joinedAt: null },
        photostat: { joined: false, position: null, peopleAhead: null, minutesUntilTurn: null, served: false, nextNotified: false, joinPosition: null, joinedAt: null }
      };

      var MEMBERSHIP_STORAGE_KEY = 'queueSync_membership';

      var toastState = {
        visible: false,
        message: '',
        type: 'success', // 'success', 'info', 'warning'
        timer: null
      };

      var nextNotificationState = {
        visible: false,
        locationId: null,
        message: '',
        kind: 'next',           // 'next' | 'served'
        soundEnabled: false,    // muted by default
        shownAt: null
      };

      // ============================================
      //          CLOUD MODE STATE
      // ============================================
      var cloudBootstrapped = false;
      var cloudSeedPromise = null;
      var cloudUnsubscribers = {};
      // While true, the user optimistically "joined" but the live snapshot
      // has not confirmed their member doc yet, so absence must NOT be read
      // as "served".
      var pendingJoin = { canteen: false, photostat: false };

      function cloudEligible() {
        return !!(
          window.QueueSyncFirebase &&
          window.QueueSyncFirebase.mode === 'cloud' &&
          FirestoreService &&
          FirestoreService.isEnabled()
        );
      }

      function isCloud() {
        return cloudBootstrapped && cloudEligible();
      }

      function getSyncMode() {
        return isCloud() ? 'cloud' : 'demo';
      }

      // ============================================
      //                HELPERS
      // ============================================

      function minutesOfDay(timeStr) {
        var parts = String(timeStr).split(':');
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      }

      function formatWindow(window) {
        return window.start + '\u2013' + window.end; // en-dash
      }

      function isTimeInWindow(mins, window) {
        var start = minutesOfDay(window.start);
        var end = minutesOfDay(window.end);
        if (start <= end) {
          return mins >= start && mins < end;
        }
        return mins >= start || mins < end;
      }

      function inAnyWindow(mins, windows) {
        return windows.some(function (w) { return isTimeInWindow(mins, w); });
      }

      function getConfig(locationId) {
        return LOCATION_CONFIG[locationId] || LOCATION_CONFIG.canteen;
      }

      function getQueue(locationId) {
        return queues[locationId] || null;
      }

      function currentStudentId() {
        return AuthService.getStudentId();
      }

      function getBusyness(locationId) {
        var queue = getQueue(locationId);
        var thresholds = getConfig(locationId).busynessThresholds;
        var count = queue ? queue.members.length : 0;

        var level = 'Low';
        for (var i = 0; i < thresholds.length; i++) {
          if (count <= thresholds[i].max) {
            level = thresholds[i].level;
            break;
          }
        }

        var tone = level === 'Low' ? 'low' : (level === 'Medium' ? 'medium' : 'high');
        return {
          level: level,
          tone: tone,
          colorClass: 'busy-' + tone,
          dotClass: 'dot-' + tone
        };
      }

      function calculateWaitTime(locationId) {
        var queue = getQueue(locationId);
        if (!queue) {
          return 0;
        }
        if (queue.members.length <= 0) {
          return 0;
        }
        return Math.ceil(queue.members.length * queue.timePerPerson);
      }

      function getBestTimeText(locationId) {
        var windows = getConfig(locationId).bestWindows;
        return windows.map(formatWindow).join(' & ');
      }

      function getCurrentAdvice(locationId) {
        var now = new Date();
        var mins = now.getHours() * 60 + now.getMinutes();
        var cfg = getConfig(locationId);

        if (inAnyWindow(mins, cfg.rushWindows)) {
          return { kind: 'crowded', text: 'Right now: usually crowded', colorClass: 'advice-crowded' };
        }
        if (inAnyWindow(mins, cfg.bestWindows)) {
          return { kind: 'light', text: 'Right now: usually light', colorClass: 'advice-light' };
        }
        return { kind: 'normal', text: 'Right now: moderate traffic', colorClass: 'advice-normal' };
      }

      var FEEDBACK_TTL_MS = 30 * 60000;

      function getLiveStatus(locationId) {
        var queue = getQueue(locationId);
        if (!queue) {
          return { value: 'normal', label: 'Normal', colorClass: 'status-normal', icon: 'clock', reports: 0 };
        }

        var cutoff = Date.now() - FEEDBACK_TTL_MS;
        var byStudent = {};

        function consider(studentId, statusValue, at) {
          if (!studentId || String(studentId).indexOf('@sim-') === 0) { return; }
          if (['fast', 'normal', 'slow'].indexOf(statusValue) === -1) { return; }
          var t = at instanceof Date ? at.getTime() : new Date(at).getTime();
          if (isNaN(t) || t < cutoff) { return; }
          var prev = byStudent[studentId];
          if (!prev || t >= prev.at) {
            byStudent[studentId] = { status: statusValue, at: t };
          }
        }

        queue.liveStatusReports.forEach(function (r) {
          consider(r.studentId, r.status, r.at);
        });
        try {
          DatabaseService.getFeedback(locationId).forEach(function (f) {
            consider(f.student_id, f.status, f.at);
          });
        } catch (e) { /* DB feedback is best-effort */ }

        var ids = Object.keys(byStudent);
        var counts = { fast: 0, normal: 0, slow: 0 };
        var latestAt = 0;
        var latestStatus = 'normal';
        ids.forEach(function (sid) {
          var r = byStudent[sid];
          counts[r.status] = (counts[r.status] || 0) + 1;
          if (r.at >= latestAt) {
            latestAt = r.at;
            latestStatus = r.status;
          }
        });

        var value = 'normal';
        if (ids.length > 0) {
          if (counts.fast > counts.normal && counts.fast > counts.slow) {
            value = 'fast';
          } else if (counts.slow > counts.fast && counts.slow > counts.normal) {
            value = 'slow';
          } else if (counts.normal > counts.fast && counts.normal > counts.slow) {
            value = 'normal';
          } else {
            value = latestStatus;
          }
        }

        var map = {
          fast:   { value: 'fast',   label: 'Moving fast', colorClass: 'status-fast',   icon: 'rocket' },
          normal: { value: 'normal', label: 'Normal',      colorClass: 'status-normal', icon: 'clock' },
          slow:   { value: 'slow',   label: 'Moving slow', colorClass: 'status-slow',   icon: 'slow' }
        };
        var out = map[value] || map.normal;
        out.reports = ids.length;
        return out;
      }

      function getQueueInfo(locationId) {
        var queue = getQueue(locationId);
        if (!queue) {
          return null;
        }
        var busyness = getBusyness(locationId);
        var now = new Date();
        return {
          locationId: locationId,
          title: queue.title,
          peopleCount: queue.members.length,
          busyness: busyness,
          estimatedWaitTime: calculateWaitTime(locationId),
          timePerPerson: queue.timePerPerson,
          liveStatus: getLiveStatus(locationId),
          bestTimeText: getBestTimeText(locationId),
          currentAdvice: getCurrentAdvice(locationId),
          refreshedAt: now
        };
      }

      // ============================================
      //         SEEDING + PERSISTENCE
      // ============================================

      function demoInitQueues() {
        Object.keys(queues).forEach(function (locationId) {
          var queue = queues[locationId];
          queue.members = [];
          queue.liveStatusReports = [];
          queue.seeded = true;
          restartServeTimer(locationId);
          mirrorQueueToDb(locationId);
        });
      }

      function initQueues() {
        if (cloudEligible()) {
          seedAndBindCloud();
          return;
        }
        demoInitQueues();
      }

      function seedAndBindCloud() {
        cloudSeedPromise = FirestoreService.seedIfNeeded()
          .then(function () {
            cloudBootstrapped = true;
            Object.keys(queues).forEach(bindCloudListeners);
          })
          .catch(function (err) {
            console.warn('QueueSync: Firestore unavailable — switching to local demo mode.', err);
            demoInitQueues();
            restoreMembershipDemoPush(currentStudentId());
          });
        return cloudSeedPromise;
      }

      function bindCloudListeners(locationId) {
        var unsubs = {};
        unsubs.members = FirestoreService.subscribeQueue(locationId, function (rows) {
          onQueueSnapshot(locationId, rows);
        });
        unsubs.feedback = FirestoreService.subscribeFeedback(locationId, function (rows) {
          onFeedbackSnapshot(locationId, rows);
        });
        cloudUnsubscribers[locationId] = unsubs;
      }

      /**
       * Real-time member snapshot handler: replaces the local mirror,
       * reconciles this device's membership and broadcasts so every view
       * (student queue pages, home cards, admin now-serving panels) updates.
       */
      function onQueueSnapshot(locationId, rows) {
        var queue = getQueue(locationId);
        if (!queue) {
          return;
        }
        queue.members = rows || [];
        queue.seeded = true;
        reconcileCloudMembership(locationId);
        broadcastQueueUpdated(locationId, null);
      }

      /**
       * Real-time feedback snapshot handler.
       */
      function onFeedbackSnapshot(locationId, rows) {
        var queue = getQueue(locationId);
        if (!queue) {
          return;
        }
        queue.liveStatusReports = rows || [];
        var aggregate = getLiveStatus(locationId);
        $rootScope.$broadcast('queue:liveStatus', {
          locationId: locationId,
          liveStatus: aggregate
        });
      }

      /**
       * Keeps THIS device's join/leave/serve state in sync with the
       * authoritative Firestore members list:
       *   - present + joined          -> refresh position/wait,
       *   - present + not joined      -> adopt the membership (other device),
       *   - absent + joined + not pending -> I was served/removed -> served flow.
       */
      function reconcileCloudMembership(locationId) {
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];
        var sid = currentStudentId();
        if (!queue || !status || !sid) {
          return;
        }

        var mine = null;
        for (var i = 0; i < queue.members.length; i++) {
          if (queue.members[i].studentId === sid) {
            mine = queue.members[i];
            break;
          }
        }

        if (mine) {
          pendingJoin[locationId] = false;
          if (status.joined) {
            if (mine.joinedAt) { status.joinedAt = mine.joinedAt; }
            recomputeUserPosition(locationId, false);
          } else {
            // Membership exists in the cloud but not on this device:
            // adopt it (joined from another device / restored session).
            status.joined = true;
            status.served = false;
            status.nextNotified = false;
            status.joinedAt = mine.joinedAt || new Date();
            status.joinPosition = null;
            recomputeUserPosition(locationId, true);
            persistMembership();
            showToast('You are still in the ' + queue.title + ' queue. Spot #' + status.position + '.', 'info');
          }
          return;
        }

        // Not in the member list. If we believed we were queued and the
        // snapshot (not an optimistic join) says otherwise -> served flow.
        if (status.joined && !pendingJoin[locationId]) {
          recomputeUserPosition(locationId, false);
        }
      }

      function broadcastQueueUpdated(locationId, servedMember) {
        $rootScope.$broadcast('queue:updated', {
          locationId: locationId,
          queue: getQueue(locationId),
          servedMember: servedMember || null
        });
        // Relays to any open admin dashboard (now-serving updates instantly).
        $rootScope.$broadcast('db:changed', { source: 'queue', locationId: locationId });
      }

      function readStoredMembership(sid) {
        var stored = null;
        try {
          stored = JSON.parse($window.sessionStorage.getItem(MEMBERSHIP_STORAGE_KEY));
        } catch (e) {
          stored = null;
        }
        if (!stored || stored.studentId !== sid || !stored.queues) {
          return null;
        }
        return stored;
      }

      /**
       * Restores the current user's membership from sessionStorage.
       * Cloud: flags only — presence/position come from the live snapshot.
       * Demo: re-appends to the in-memory FIFO list.
       */
      function restoreMembership() {
        var sid = currentStudentId();
        if (!sid) {
          return;
        }
        if (cloudEligible()) {
          restoreMembershipCloudFlags(sid);
          return;
        }
        restoreMembershipDemoPush(sid);
      }

      function restoreMembershipCloudFlags(sid) {
        var stored = readStoredMembership(sid);
        if (!stored) {
          return;
        }
        stored.queues.forEach(function (entry) {
          var status = userQueueStatus[entry.locationId];
          if (!status) {
            return;
          }
          status.joined = true;
          status.nextNotified = false;
          status.joinedAt = new Date(entry.joinedAt);
          status.joinPosition = entry.joinPosition || null;
          status.served = false;
        });
      }

      function restoreMembershipDemoPush(sid) {
        if (!sid) {
          return;
        }
        var stored = readStoredMembership(sid);
        if (!stored) {
          return;
        }
        stored.queues.forEach(function (entry) {
          var queue = getQueue(entry.locationId);
          var status = userQueueStatus[entry.locationId];
          if (!queue || !status) {
            return;
          }
          queue.members.push({
            studentId: sid,
            simulated: false,
            joinedAt: new Date(entry.joinedAt)
          });
          status.joined = true;
          status.nextNotified = false;
          status.joinedAt = new Date(entry.joinedAt);
          status.joinPosition = entry.joinPosition || null;
          status.served = false;
          recomputeUserPosition(entry.locationId, false);
          restartServeTimer(entry.locationId);
        });
      }

      function persistMembership() {
        var sid = currentStudentId();
        if (!sid) {
          try { $window.sessionStorage.removeItem(MEMBERSHIP_STORAGE_KEY); } catch (e) { /* noop */ }
          return;
        }
        var entries = [];
        ['canteen', 'photostat'].forEach(function (locationId) {
          var status = userQueueStatus[locationId];
          if (status && status.joined && status.joinedAt) {
            entries.push({
              locationId: locationId,
              joinedAt: status.joinedAt.toISOString ? status.joinedAt.toISOString() : new Date(),
              joinPosition: status.joinPosition || null
            });
          }
        });
        try {
          $window.sessionStorage.setItem(
            MEMBERSHIP_STORAGE_KEY,
            JSON.stringify({ studentId: sid, queues: entries })
          );
        } catch (e) { /* noop */ }
      }

      // ============================================
      //          SERVING / SERVICE LOOP
      // ============================================

      /**
       * Demo fallback: pops the front member locally. In cloud mode the
       * admin "Serve" buttons call completeCurrent() -> Firestore, and the
       * snapshot does the advancing here on every device.
       */
      function serveNext(locationId) {
        var queue = getQueue(locationId);
        if (!queue || !queue.members.length) {
          return;
        }
        var servedMember = queue.members.shift();
        finalizeQueueState(locationId, servedMember);
      }

      function restartServeTimer(locationId) {
        if (isCloud()) {
          return; // service is driven by the admin/cloud, not a local timer
        }
        var queue = getQueue(locationId);
        if (!queue) {
          return;
        }
        if (queue.serveTimer) {
          $timeout.cancel(queue.serveTimer);
          queue.serveTimer = null;
        }
        if (!queue.members.length) {
          return;
        }
        var msPerServe = queue.timePerPerson * 60000 / SIMULATION_SPEED;
        queue.serveTimer = $timeout(function tick() {
          serveNext(locationId);
          if (queue.members.length > 0) {
            restartServeTimer(locationId);
          } else {
            queue.serveTimer = null;
          }
        }, msPerServe);
      }

      function finalizeQueueState(locationId, servedMember) {
        var queue = getQueue(locationId);
        if (!queue) {
          return;
        }
        recomputeUserPosition(locationId, false);
        mirrorQueueToDb(locationId);
        $rootScope.$broadcast('queue:updated', {
          locationId: locationId,
          queue: queue,
          servedMember: servedMember || null
        });
        // Keep any open admin dashboard's "Now Serving" panels live in demo
        // mode too (in cloud mode the snapshot already fires this).
        $rootScope.$broadcast('db:changed', { source: 'queue', locationId: locationId });
      }

      function mirrorQueueToDb(locationId) {
        if (isCloud()) {
          return; // truth lives in Firestore, not the legacy DB mirror
        }
        try {
          var queue = getQueue(locationId);
          if (!queue || !DatabaseService) { return; }
          var ids = queue.members.map(function (m) { return m.studentId; });
          DatabaseService.syncQueueMembers(locationId, ids);
        } catch (e) { /* DB mirror is best-effort */ }
      }

      function recomputeUserPosition(locationId, isJoin) {
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];
        if (!queue || !status || !status.joined) {
          return;
        }

        var sid = currentStudentId();
        var index = -1;
        for (var i = 0; i < queue.members.length; i++) {
          if (queue.members[i].studentId === sid) {
            index = i;
            break;
          }
        }

        var prevPosition = status.position;

        if (index === -1) {
          // The user just got served (popped off the front, or removed by staff).
          var now = new Date();
          var waitEstimate = status.joinPosition ? (status.joinPosition - 1) * queue.timePerPerson : 0;
          status.joined = false;
          status.position = null;
          status.peopleAhead = null;
          status.minutesUntilTurn = null;
          status.served = true;
          status.nextNotified = false;
          status.joinPosition = null;

          UserService.addQueueHistory({
            locationId: locationId,
            joinedAt: status.joinedAt || now,
            servedAt: now,
            leftAt: null,
            status: 'Completed',
            waitTimeMinutes: Math.max(0, Math.round(waitEstimate))
          });

          showToast('You\u2019ve reached the counter at ' + queue.title + '! \u2014 Queue completed.', 'success');

          if (nextNotificationState.locationId === locationId) {
            nextNotificationState.visible = false;
          }

          $rootScope.$broadcast('queue:served', { locationId: locationId });
          persistMembership();
          return;
        }

        var newPosition = index + 1;
        status.position = newPosition;
        status.peopleAhead = index;
        status.minutesUntilTurn = index * queue.timePerPerson;

        if ((!status.nextNotified && prevPosition === 2 && newPosition === 1) ||
            (isJoin && newPosition === 1 && !status.nextNotified)) {
          status.nextNotified = true;
          triggerNextNotification(locationId, isJoin && newPosition === 1);
        }
      }

      // ============================================
      //        "YOU'RE NEXT" NOTIFICATION
      // ============================================
      function triggerNextNotification(locationId, atFront) {
        var queue = getQueue(locationId);
        nextNotificationState.locationId = locationId;
        nextNotificationState.message = atFront
          ? 'You\u2019re at the ' + queue.title + ' counter now!'
          : 'You\u2019re next in the ' + queue.title + ' queue!';
        nextNotificationState.kind = 'next';
        nextNotificationState.visible = true;
        nextNotificationState.shownAt = new Date();

        if (nextNotificationState.soundEnabled) {
          playChime();
        }

        $rootScope.$broadcast('queue:next', {
          locationId: locationId,
          message: nextNotificationState.message
        });
      }

      function dismissNextNotification() {
        nextNotificationState.visible = false;
      }

      function toggleNextSound() {
        nextNotificationState.soundEnabled = !nextNotificationState.soundEnabled;
        if (nextNotificationState.soundEnabled) {
          playChime();
        }
        return nextNotificationState.soundEnabled;
      }

      function playChime() {
        try {
          var Ctx = $window.AudioContext || $window.webkitAudioContext;
          if (!Ctx) {
            return;
          }
          var ctx = new Ctx();
          var notes = [880, 1320];
          notes.forEach(function (freq, i) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
            gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.35);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.18);
            osc.stop(ctx.currentTime + i * 0.18 + 0.4);
          });
          $window.setTimeout(function () { ctx.close(); }, 1000);
        } catch (e) {
          // Audio not available; ignore silently.
        }
      }

      // ============================================
      //              TOAST
      // ============================================
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

      // ============================================
      //              PUBLIC API
      // ============================================

      function getQueues() {
        return queues;
      }

      function getUserStatus(locationId) {
        return userQueueStatus[locationId] || { joined: false, position: null, peopleAhead: null, minutesUntilTurn: null, served: false, nextNotified: false, joinedAt: null };
      }

      /**
       * Current position (and derived info) for a student in a queue.
       */
      function getUserPosition(locationId, studentId) {
        var queue = getQueue(locationId);
        if (!queue) {
          return null;
        }
        for (var i = 0; i < queue.members.length; i++) {
          if (queue.members[i].studentId === studentId) {
            return {
              position: i + 1,
              peopleAhead: i,
              minutesUntilTurn: i * queue.timePerPerson
            };
          }
        }
        return null;
      }

      /**
       * The FIRST entry in a queue — what the staff are about to handle.
       * @returns {{studentId:string, joinedAt:Date, request:Object|null, position:number}|null}
       */
      function getNowServing(locationId) {
        var queue = getQueue(locationId);
        if (!queue || !queue.members.length) {
          return null;
        }
        var first = queue.members[0];
        return {
          studentId: first.studentId,
          joinedAt: first.joinedAt || null,
          request: first.request || null,
          position: 1
        };
      }

      /**
       * Joins the queue for `locationId` as `studentId`.
       * @returns {Promise<{queue:Object, status:Object, position:number}>}
       */
      function joinQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        if (!queue || !status) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        if (status.joined) {
          deferred.resolve({ queue: queue, status: status, position: status.position });
          return deferred.promise;
        }

        var run = function () {
          if (isCloud()) {
            joinQueueCloud(locationId, studentId).then(
              function (res) { deferred.resolve(res); },
              function (err) { deferred.reject(err); }
            );
          } else {
            demoJoinQueue(locationId, studentId).then(
              function (res) { deferred.resolve(res); },
              function (err) { deferred.reject(err); }
            );
          }
        };

        if (cloudEligible() && !cloudBootstrapped) {
          cloudSeedPromise.then(run, run);
        } else {
          run();
        }

        return deferred.promise;
      }

      function joinQueueCloud(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        FirestoreService.joinQueue(locationId, studentId)
          .then(function (res) {
            pendingJoin[locationId] = true;
            status.joined = true;
            status.served = false;
            status.nextNotified = false;
            status.joinedAt = new Date();
            status.position = res.position || null;
            status.joinPosition = res.position || null;

            persistMembership();
            broadcastQueueUpdated(locationId, null);

            showToast(
              'You joined the ' + queue.title + ' queue.' +
              (res.position ? ' Spot #' + res.position + '.' : ''),
              'success'
            );

            deferred.resolve({ queue: queue, status: status, position: res.position });
          })
          .catch(function (err) {
            pendingJoin[locationId] = false;
            status.joined = false;
            status.position = null;
            deferred.reject(err);
          });

        return deferred.promise;
      }

      function demoJoinQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        $timeout(function () {
          if (status.joined) {
            deferred.resolve({ queue: queue, status: status, position: status.position });
            return;
          }

          queue.members.push({
            studentId: studentId,
            simulated: false,
            joinedAt: new Date()
          });

          status.joined = true;
          status.served = false;
          status.nextNotified = false;
          status.joinedAt = new Date();

          recomputeUserPosition(locationId, true);
          status.joinPosition = status.position;

          restartServeTimer(locationId);
          finalizeQueueState(locationId);
          persistMembership();

          showToast('You joined the ' + queue.title + ' queue. Spot #' + status.position + '.', 'success');

          deferred.resolve({
            queue: queue,
            status: status,
            position: status.position
          });
        }, 400);

        return deferred.promise;
      }

      /**
       * Leaves the queue early (counts as "Left early" history).
       * @returns {Promise<{queue:Object, status:Object}>}
       */
      function leaveQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        if (!queue || !status) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        if (!status.joined) {
          deferred.resolve({ queue: queue, status: status });
          return deferred.promise;
        }

        var run = function () {
          if (isCloud()) {
            leaveQueueCloud(locationId, studentId).then(
              function (res) { deferred.resolve(res); },
              function (err) { deferred.reject(err); }
            );
          } else {
            demoLeaveQueue(locationId, studentId).then(
              function (res) { deferred.resolve(res); },
              function (err) { deferred.reject(err); }
            );
          }
        };

        if (cloudEligible() && !cloudBootstrapped) {
          cloudSeedPromise.then(run, run);
        } else {
          run();
        }

        return deferred.promise;
      }

      function leaveQueueCloud(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        FirestoreService.leaveQueue(locationId, studentId)
          .then(function () {
            var now = new Date();
            var elapsed = status.joinedAt ? Math.round((now.getTime() - status.joinedAt.getTime()) / 60000) : 0;
            var waitEstimate = status.joinPosition ? (status.joinPosition - 1) * queue.timePerPerson : elapsed;

            UserService.addQueueHistory({
              locationId: locationId,
              joinedAt: status.joinedAt || now,
              servedAt: null,
              leftAt: now,
              status: 'Left early',
              waitTimeMinutes: Math.max(0, Math.round(waitEstimate))
            });

            status.joined = false;
            status.position = null;
            status.peopleAhead = null;
            status.minutesUntilTurn = null;
            status.served = false;
            status.nextNotified = false;
            status.joinPosition = null;
            status.joinedAt = null;
            pendingJoin[locationId] = false;

            persistMembership();
            broadcastQueueUpdated(locationId, null);
            showToast('You left the ' + queue.title + ' queue.', 'info');

            deferred.resolve({ queue: queue, status: status });
          })
          .catch(function (err) {
            deferred.reject(err);
          });

        return deferred.promise;
      }

      function demoLeaveQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        $timeout(function () {
          if (!status.joined) {
            deferred.resolve({ queue: queue, status: status });
            return;
          }

          for (var i = 0; i < queue.members.length; i++) {
            if (queue.members[i].studentId === studentId) {
              queue.members.splice(i, 1);
              break;
            }
          }

          var now = new Date();
          var elapsed = status.joinedAt ? Math.round((now.getTime() - status.joinedAt.getTime()) / 60000) : 0;
          var waitEstimate = status.joinPosition ? (status.joinPosition - 1) * queue.timePerPerson : elapsed;

          UserService.addQueueHistory({
            locationId: locationId,
            joinedAt: status.joinedAt || now,
            servedAt: null,
            leftAt: now,
            status: 'Left early',
            waitTimeMinutes: Math.max(0, Math.round(waitEstimate))
          });

          status.joined = false;
          status.position = null;
          status.peopleAhead = null;
          status.minutesUntilTurn = null;
          status.served = false;
          status.nextNotified = false;
          status.joinPosition = null;
          status.joinedAt = null;

          finalizeQueueState(locationId);
          persistMembership();

          showToast('You left the ' + queue.title + ' queue.', 'info');

          deferred.resolve({ queue: queue, status: status });
        }, 400);

        return deferred.promise;
      }

      /**
       * Whenever something meaningful about a member changes (e.g. a photostat
       * job is confirmed + attached to the member document), call this so the
       * admin "Now Serving" panel shows the true payload in real time.
       * @param {string} locationId
       * @param {Object} request - payload: { orderNo, serviceId, serviceLabel,
       *   pages, copies, color, sides, files, amount, paymentLabel, paidAt }
       * @returns {Promise<{ok:boolean, degraded?:boolean}>}
       */
      function setRequestPayload(locationId, request) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var sid = currentStudentId();

        if (!queue || !sid) {
          deferred.reject(new Error('You must be logged in to set request details.'));
          return deferred.promise;
        }

        function finalize() {
          // Update the local mirror immediately (single-tab UX cookies along).
          for (var i = 0; i < queue.members.length; i++) {
            if (queue.members[i].studentId === sid) {
              queue.members[i].request = request;
              break;
            }
          }
          broadcastQueueUpdated(locationId, null);
          deferred.resolve({ ok: true });
        }

        if (isCloud()) {
          FirestoreService.saveRequest(locationId, sid, request)
            .then(function () { finalize(); })
            .catch(function (err) {
              console.warn('QueueSync: request payload write failed (degraded mode).', err);
              finalize();
            });
        } else {
          finalize();
        }

        return deferred.promise;
      }

      /**
       * THE single admin action to serve the current request. Atomically
       * archives + deletes the first queue entry (cloud) or pops it locally
       * (demo), so the next person becomes "Now Serving" on every device.
       * @param {string} locationId 'canteen' | 'photostat'
       * @returns {Promise<{studentId:string, data:Object, request:Object|null}|null>}
       */
      function completeCurrent(locationId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);

        if (!queue) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        var run = function () {
          if (isCloud()) {
            FirestoreService.completeRequest(locationId)
              .then(function (res) {
                broadcastQueueUpdated(locationId, null);
                deferred.resolve(res);
              })
              .catch(function (err) {
                deferred.reject(err);
              });
            return;
          }

          // Demo fallback: pop the front member locally.
          if (!queue.members.length) {
            deferred.resolve(null);
            return;
          }
          var served = queue.members.shift();
          finalizeQueueState(locationId, served);
          deferred.resolve({
            studentId: served.studentId,
            data: served,
            request: served.request || null
          });
        };

        if (cloudEligible() && !cloudBootstrapped) {
          cloudSeedPromise.then(run, run);
        } else {
          run();
        }

        return deferred.promise;
      }

      /**
       * Records the current user's live-status report for a queue.
       * @returns {Promise<Object>} aggregate live status
       */
      function updateLiveStatus(locationId, studentId, statusValue) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        if (!queue || !status || !status.joined) {
          deferred.reject(new Error('You must be in this queue to report live status.'));
          return deferred.promise;
        }

        var valid = ['fast', 'normal', 'slow'].indexOf(statusValue) !== -1;
        if (!valid) {
          deferred.reject(new Error('Invalid status: ' + statusValue));
          return deferred.promise;
        }

        var run = function () {
          if (isCloud()) {
            FirestoreService.updateFeedback(locationId, studentId, statusValue)
              .catch(function (err) { console.warn('QueueSync: feedback write failed.', err); });
            applyLocalLiveReport(locationId, studentId, statusValue);
            var aggregate = getLiveStatus(locationId);
            deferred.resolve(aggregate);
            $rootScope.$broadcast('queue:liveStatus', {
              locationId: locationId,
              liveStatus: aggregate
            });
          } else {
            demoUpdateLiveStatus(locationId, studentId, statusValue).then(
              function (agg) { deferred.resolve(agg); },
              function (err) { deferred.reject(err); }
            );
          }
        };

        if (cloudEligible() && !cloudBootstrapped) {
          cloudSeedPromise.then(run, run);
        } else {
          run();
        }

        return deferred.promise;
      }

      function applyLocalLiveReport(locationId, studentId, statusValue) {
        var queue = getQueue(locationId);
        if (!queue) {
          return;
        }
        var found = false;
        for (var i = 0; i < queue.liveStatusReports.length; i++) {
          if (queue.liveStatusReports[i].studentId === studentId) {
            queue.liveStatusReports[i].status = statusValue;
            queue.liveStatusReports[i].at = new Date();
            found = true;
            break;
          }
        }
        if (!found) {
          queue.liveStatusReports.push({ studentId: studentId, status: statusValue, at: new Date() });
        }
      }

      function demoUpdateLiveStatus(locationId, studentId, statusValue) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);

        $timeout(function () {
          applyLocalLiveReport(locationId, studentId, statusValue);

          try {
            DatabaseService.saveFeedback(locationId, studentId, statusValue);
          } catch (e) { /* DB write is best-effort */ }

          var aggregate = getLiveStatus(locationId);
          deferred.resolve(aggregate);

          $rootScope.$broadcast('queue:liveStatus', {
            locationId: locationId,
            liveStatus: aggregate
          });
        }, 250);

        return deferred.promise;
      }

      /**
       * Demo helper: rescale how fast simulated minutes pass.
       */
      function setSimulationSpeed(factor) {
        SIMULATION_SPEED = factor || 1;
        if (!isCloud()) {
          Object.keys(queues).forEach(function (locationId) {
            restartServeTimer(locationId);
          });
        }
        return SIMULATION_SPEED;
      }

      function getSimulationSpeed() {
        return SIMULATION_SPEED;
      }

      /**
       * Clears in-memory demo state + user membership on logout.
       * Cloud queues (the live Firestore members) are intentionally left
       * intact — the queue belongs to everyone, not the session.
       */
      function resetDemoData() {
        ['canteen', 'photostat'].forEach(function (locationId) {
          var queue = getQueue(locationId);
          if (queue && queue.serveTimer) {
            $timeout.cancel(queue.serveTimer);
            queue.serveTimer = null;
          }
        });
        ['canteen', 'photostat'].forEach(function (locationId) {
          var status = userQueueStatus[locationId];
          status.joined = false;
          status.position = null;
          status.peopleAhead = null;
          status.minutesUntilTurn = null;
          status.served = false;
          status.nextNotified = false;
          status.joinPosition = null;
          status.joinedAt = null;
        });
        pendingJoin = { canteen: false, photostat: false };
        persistMembership();
        if (!cloudEligible()) {
          demoInitQueues();
        }
      }

      // ============================================
      //              INITIALIZATION
      // ============================================
      initQueues();
      restoreMembership();

      return {
        getQueues: getQueues,
        getQueue: getQueue,
        getQueueInfo: getQueueInfo,
        getUserStatus: getUserStatus,
        getUserPosition: getUserPosition,
        getBusyness: getBusyness,
        getBestTimeText: getBestTimeText,
        getCurrentAdvice: getCurrentAdvice,
        calculateWaitTime: calculateWaitTime,
        getNowServing: getNowServing,
        joinQueue: joinQueue,
        leaveQueue: leaveQueue,
        setRequestPayload: setRequestPayload,
        completeCurrent: completeCurrent,
        updateLiveStatus: updateLiveStatus,
        setSimulationSpeed: setSimulationSpeed,
        getSimulationSpeed: getSimulationSpeed,
        getSyncMode: getSyncMode,
        resetDemoData: resetDemoData,
        toastState: toastState,
        showToast: showToast,
        hideToast: hideToast,
        nextNotification: nextNotificationState,
        dismissNextNotification: dismissNextNotification,
        toggleNextSound: toggleNextSound
      };
    }
  ]);
})();