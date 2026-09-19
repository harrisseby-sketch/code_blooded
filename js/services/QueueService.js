/* ============================================
   QueueSync - QueueService
   Manages campus queue states, busyness levels,
   predictive wait times, best-time recommendations,
   live status reports, dynamic positions and the
   simulated service loop. Simulated in-memory now,
   but every method is structured so the internals
   can be swapped for Firebase Firestore later.
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
    function ($q, $timeout, $rootScope, $window, AuthService, UserService, DatabaseService) {

      // ============================================
      //        CONFIGURATION (per location)
      // ============================================
      // Everything here is deliberately "data-driven" so it can be moved to
      // Firebase later. Each location doc in Firestore would carry:
      //   { timePerPerson, busynessThresholds, rushWindows, bestWindows }
      //
      // Example future Firestore path:
      //   doc(db, 'queueConfig', locationId).get()  ->  merge into CONFIG below
      // ============================================

      // How many real seconds equal one simulated minute.
      //   1   -> real-time (1 simulated minute = 60 real seconds)
      //   30  -> fast demo
      //   120 -> turbo demo
      // For now this is a local constant; later it can be a per-location
      // Firestore field (e.g. demoMode.secondsPerMinute).
      var SIMULATION_SPEED = 1;

      // Thresholds map a queue length to a busyness level.
      // Order matters: first matching `max` wins.
      var DEFAULT_BUSYNESS_THRESHOLDS = [
        { max: 5,  level: 'Low' },      // 0-5
        { max: 12, level: 'Medium' },   // 6-12
        { max: Infinity, level: 'High' }// 13+
      ];

      var LOCATION_CONFIG = {
        canteen: {
          timePerPerson: 1, // 1 minute per person (per spec)
          // TODO(Firebase): busynessThresholds / timePerPerson can become
          // per-location.doc('canteen') fields instead of hardcoded below.
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
      //          IN-MEMORY QUEUE STORE
      // ============================================
      // `members` is an ordered FIFO list. Count is always members.length.
      // `liveStatusReports` is an in-memory array of { studentId, status, at }.
      //
      // TODO(Firebase): replace with
      //   onSnapshot(doc(db, 'queues', locationId))            -> queue stats
      //   onSnapshot(collection(db,'queues',loc,'members'))    -> member list
      //   onSnapshot(collection(db,'queues',loc,'statusReports')) -> live status
      // ============================================
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
          members: [],          // FIFO: [{ studentId, simulated, joinedAt }]
          liveStatusReports: [],// [{ studentId, status, at }]
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

      // Seed baseline (simulated "other people") counts so busyness levels
      // and the auto-decrement simulation are visibly demo-able immediately.
      var SEED_COUNTS = {
        canteen: 14,   // -> busyness High
        photostat: 6   // -> busyness Medium
      };

      // The current user's membership per location.
      // Persisted in sessionStorage so status (and the served flow) survives
      // navigation and even a page refresh while the session is active.
      var userQueueStatus = {
        canteen: { joined: false, position: null, peopleAhead: null, minutesUntilTurn: null, served: false, nextNotified: false, joinPosition: null, joinedAt: null },
        photostat: { joined: false, position: null, peopleAhead: null, minutesUntilTurn: null, served: false, nextNotified: false, joinPosition: null, joinedAt: null }
      };

      var MEMBERSHIP_STORAGE_KEY = 'queueSync_membership';

      // Active Toast Notification State
      var toastState = {
        visible: false,
        message: '',
        type: 'success', // 'success', 'info', 'warning'
        timer: null
      };

      // Global "You're next" notification banner state
      // Rendered app-wide in index.html so it works on any route.
      var nextNotificationState = {
        visible: false,
        locationId: null,
        message: '',
        kind: 'next',           // 'next' | 'served'
        soundEnabled: false,    // muted by default
        shownAt: null
      };

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
        // Handle windows that wrap across midnight (none currently, but robust).
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

      /**
       * Busyness level derived from the current queue length.
       * @returns {{level: string, tone: string, colorClass: string}}
       */
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

      /**
       * Predictive wait time: numberOfPeople * timePerPerson.
       * timePerPerson is config-driven (and Firebase-ready).
       */
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

      /**
       * "Best time to visit" line, e.g. "10:00-12:00 & 15:00-17:00".
       */
      function getBestTimeText(locationId) {
        var windows = getConfig(locationId).bestWindows;
        return windows.map(formatWindow).join(' & ');
      }

      /**
       * Time-of-day advice for right now.
       * @returns {{kind: string, text: string, colorClass: string}}
       */
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

      /**
       * Aggregates all current live status reports for a location.
       * Uses simple majority ("fast"/"normal"/"slow"), falling back to the
       * latest report on a tie, then to "normal" when nobody has reported.
       *
       * TODO(Firebase): this list of reports would be
       * onSnapshot(collection(db,'queues',loc,'statusReports')) and the
       * aggregation can move to a Cloud Function if preferred.
       */
      function getLiveStatus(locationId) {
        var queue = getQueue(locationId);
        if (!queue) {
          return { value: 'normal', label: 'Normal', colorClass: 'status-normal', icon: 'clock' };
        }

        var memberIds = {};
        queue.members.forEach(function (m) { memberIds[m.studentId] = true; });

        // Only honor reports from users currently in the queue.
        var active = queue.liveStatusReports.filter(function (r) {
          return memberIds[r.studentId];
        });

        var counts = { fast: 0, normal: 0, slow: 0 };
        active.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });

        var value = 'normal';
        if (active.length > 0) {
          if (counts.fast > counts.normal && counts.fast > counts.slow) {
            value = 'fast';
          } else if (counts.slow > counts.fast && counts.slow > counts.normal) {
            value = 'slow';
          } else if (counts.normal > 0) {
            value = 'normal';
          } else {
            // Tie (e.g. fast & slow) -> use the most recent report.
            var latest = active[active.length - 1];
            value = latest.status;
          }
        }

        var map = {
          fast:   { value: 'fast',   label: 'Moving fast', colorClass: 'status-fast',   icon: 'rocket' },
          normal: { value: 'normal', label: 'Normal',      colorClass: 'status-normal', icon: 'clock' },
          slow:   { value: 'slow',   label: 'Moving slow', colorClass: 'status-slow',   icon: 'slow' }
        };
        return map[value] || map.normal;
      }

      /**
       * Full queue info object used by Home cards and detail pages.
       */
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

      /**
       * Re-populates each queue with simulated "other people" so the demo
       * always starts with healthy queue lengths. Called on first run and on
       * logout (clean slate for the next demo user).
       */
      function seedQueues() {
        Object.keys(queues).forEach(function (locationId) {
          var queue = queues[locationId];
          var seedCount = SEED_COUNTS[locationId] || 0;
          queue.members = [];
          queue.liveStatusReports = [];
          queue.seeded = true;

          for (var i = 1; i <= seedCount; i++) {
            queue.members.push({
              studentId: '@sim-' + locationId + '-' + i,
              simulated: true,
              joinedAt: new Date(Date.now() - (i * queue.timePerPerson * 60000))
            });
          }

          // A few baseline simulated status reports keep the live status thinking
          queue.liveStatusReports.push(
            { studentId: '@sim-' + locationId + '-1', status: 'normal', at: new Date() },
            { studentId: '@sim-' + locationId + '-2', status: locationId === 'canteen' ? 'fast' : 'slow', at: new Date() }
          );

          restartServeTimer(locationId);
          mirrorQueueToDb(locationId);
        });
      }

      /**
       * Restores the current user's membership from sessionStorage so the
       * queue position + simulation keep working across navigation/refresh.
       */
      function restoreMembership() {
        var sid = currentStudentId();
        if (!sid) {
          return;
        }
        var stored = null;
        try {
          stored = JSON.parse($window.sessionStorage.getItem(MEMBERSHIP_STORAGE_KEY));
        } catch (e) {
          stored = null;
        }
        if (!stored || stored.studentId !== sid || !stored.queues) {
          return;
        }
        stored.queues.forEach(function (entry) {
          var queue = getQueue(entry.locationId);
          var status = userQueueStatus[entry.locationId];
          if (!queue || !status) {
            return;
          }
          // Drop the trailing placeholder slot if the user had joined during
          // this session and the simulation already popped it (index -1).
          // Simply re-append the user to the tail; their real position is
          // recomputed on the next serve tick anyway.
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

      /**
       * Simulated service process. Every `timePerPerson` (simulated) minutes
       * the front person is served and leaves the queue, which:
       *   - decreases the count,
       *   - advances every member's position,
       *   - possibly triggers "You're next" and "served" flows for the user.
       *
       * TODO(Firebase): replace the local timer with
       *   onSnapshot(doc(db,'queues',locationId)) where staff simply set
       *   `lastServedAt` (or call a "markServed" cloud function) and counts /
       *   positions update server-side. This method stays as a graceful
       *   offline/demo fallback.
       */
      function serveNext(locationId) {
        var queue = getQueue(locationId);
        if (!queue || !queue.members.length) {
          return;
        }

        var servedMember = queue.members.shift();

        // Recompute derived values + the current user's position.
        finalizeQueueState(locationId, servedMember);
      }

      function restartServeTimer(locationId) {
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
          // Reschedule while people remain.
          if (queue.members.length > 0) {
            restartServeTimer(locationId);
          } else {
            queue.serveTimer = null;
          }
        }, msPerServe);
      }

      /**
       * Recomputes count, wait time, busyness and the current user's position
       * after any mutation. Broadcasts the canonical "queue:updated" event.
       * Also mirrors membership into the virtual live DB so the admin
       * dashboard (same browser other tab, or after refresh) stays live.
       */
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
      }

      /**
       * Mirrors the in-memory FIFO member list into
       * student_db.queue_members (FK student_id -> students.id) so the
       * admin dashboard has a live, shared view of both queues.
       */
      function mirrorQueueToDb(locationId) {
        try {
          var queue = getQueue(locationId);
          if (!queue || !DatabaseService) { return; }
          var ids = queue.members.map(function (m) { return m.studentId; });
          DatabaseService.syncQueueMembers(locationId, ids);
        } catch (e) { /* DB mirror is best-effort */ }
      }

      /**
       * Recomputes the logged-in user's position within a queue, handling:
       *   - position drift as people are served,
       *   - the 2 -> 1 "You're next" transition,
       *   - popping off the front => "served / reached counter".
       */
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
          // The user just got served (popped off the front). Record history.
          var now = new Date();
          // Wait they actually experienced: people ahead at join * timePerPerson.
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

          // The "You're next" banner is now stale - clear it if visible.
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

        // 2 -> 1 transition OR joining straight at the front => "You're next".
        if ((!status.nextNotified && prevPosition === 2 && newPosition === 1) ||
            (isJoin && newPosition === 1 && !status.nextNotified)) {
          status.nextNotified = true;
          triggerNextNotification(locationId, isJoin && newPosition === 1);
        }
      }

      // ============================================
      //        "YOU'RE NEXT" NOTIFICATION
      // ============================================
      /**
       * App-wide banner state. Rendered in index.html so it survives route
       * changes. In a full build this would be a Firebase Cloud Messaging
       * push (tokens stored at users/{studentId}/tokens) or a Firestore
       * `notifications/{studentId}/...` sub-collection with an in-app watcher.
       */
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

      /**
       * Subtle two-tone chime via WebAudio. Muted unless the user opts in.
       */
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
       * @returns {{position:number, peopleAhead:number, minutesUntilTurn:number}|null}
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
       * Joins the queue for `locationId` as `studentId`.
       * @returns {Promise<{queue:Object, status:Object, position:number}>}
       *
       * TODO(Firebase): replace the in-memory append with a Firestore
       * transaction on doc(db,'queues',locationId) that sets count + adds a
       * member doc under queues/{loc}/members/{studentId}. The returned
       * position is then the transaction result.
       */
      function joinQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        if (!queue || !status) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        // Simulate network latency (mirrors a Firebase write round-trip)
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

          // Compute real position from FIFO order.
          recomputeUserPosition(locationId, true);

          // Preserve position at join for historical wait calculation.
          status.joinPosition = status.position;

          // Make sure the service loop is running for this queue.
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
       *
       * TODO(Firebase): transaction.delete(doc(db,'queues',loc,'members',studentId))
       * + decrement count; write users/{studentId}/history entry.
       */
      function leaveQueue(locationId, studentId) {
        var deferred = $q.defer();
        var queue = getQueue(locationId);
        var status = userQueueStatus[locationId];

        if (!queue || !status) {
          deferred.reject(new Error('Unknown location: ' + locationId));
          return deferred.promise;
        }

        $timeout(function () {
          if (!status.joined) {
            deferred.resolve({ queue: queue, status: status });
            return;
          }

          // Remove from FIFO list.
          for (var i = 0; i < queue.members.length; i++) {
            if (queue.members[i].studentId === studentId) {
              queue.members.splice(i, 1);
              break;
            }
          }

          var now = new Date();
          var elapsed = status.joinedAt ? Math.round((now.getTime() - status.joinedAt.getTime()) / 60000) : 0;
          var waitEstimate = status.joinPosition ? (status.joinPosition - 1) * queue.timePerPerson : elapsed;

          // Record history entry before clearing status.
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
       * Records the current user's live-status report for a queue.
       * Only honored while the user is a member.
       * @returns {Promise<Object>} aggregate live status
       *
       * TODO(Firebase): set(doc(db,'queues',loc,'statusReports',studentId), status)
       * The aggregation (`getLiveStatus`) would derive from onSnapshot of that
       * sub-collection.
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

        $timeout(function () {
          // Latest report wins for this student.
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
       *   1  => 1 simulated minute per real minute
       *   30 => 2 real seconds per simulated minute
       *   120=> 0.5 real seconds per simulated minute
       */
      function setSimulationSpeed(factor) {
        SIMULATION_SPEED = factor || 1;
        Object.keys(queues).forEach(function (locationId) {
          restartServeTimer(locationId);
        });
        return SIMULATION_SPEED;
      }

      function getSimulationSpeed() {
        return SIMULATION_SPEED;
      }

      /**
       * Clears in-memory demo state + user membership on logout so a fresh
       * login starts with a clean, seeded demo.
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
        persistMembership();
        seedQueues();
      }

      // ============================================
      //              INITIALIZATION
      // ============================================
      seedQueues();
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
        joinQueue: joinQueue,
        leaveQueue: leaveQueue,
        updateLiveStatus: updateLiveStatus,
        setSimulationSpeed: setSimulationSpeed,
        getSimulationSpeed: getSimulationSpeed,
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