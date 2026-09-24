/* ============================================
   QueueSync - Firestore Service (Real-Time Data Layer)
   -------------------------------------------------
   Owns every Firestore read/write so the rest of the app
   never talks to Firestore directly. Works only when
   window.QueueSyncFirebase.enabled is true (cloud mode);
   otherwise every method rejects so callers can fall back
   to the local demo implementation.

   Data model
   ----------
   queues/{locationId}                      -> { count, updatedAt }
   queues/{locationId}/members/{studentId}  -> { joinedAt,
                                                 request: { ... } }
       `request` is the CURATED job/order payload shown to the
       staff on the admin "Now Serving" card (photostat job
       details today; canteen orders are placed AT the counter
       after serving, so they live in the orders table instead).
   queues/{locationId}/history/{studentId}  -> copy of a served
       member: { studentId, joinedAt, request, status:'Served',
                 servedAt } written atomically on serve.
   queues/{locationId}/feedback/{studentId} -> { status, at }

   The authoritative member order is the live members snapshot
   sorted by `joinedAt` (oldest first = first to be served).
   `count` is kept in sync via transactions (never used as the
   source of truth for positions), keeping it correct under
   concurrent joins/serves.
   ============================================ */

(function () {
  'use strict';

  angular
    .module('queueSyncApp')
    .factory('FirestoreService', [
      '$q',
      '$timeout',
      function ($q, $timeout) {
        function isEnabled() {
          return !!(
            window.QueueSyncFirebase &&
            window.QueueSyncFirebase.enabled &&
            window.QueueSyncFirebase.db
          );
        }

        function fs() {
          return window.QueueSyncFirebase.db;
        }

        function field() {
          return window.firebase.firestore.FieldValue;
        }

        // Angular-digest aware wrapper around a native promise: lets .then
        // callbacks in services/controllers run inside the digest cycle.
        function wrap(nativePromise) {
          return $q(function (resolve, reject) {
            nativePromise.then(
              function (value) { resolve(value); },
              function (err) { reject(err); }
            );
          });
        }

        // Normalise a Firestore Timestamp / Date / epoch object to a JS Date.
        function toDate(value) {
          if (!value) return null;
          if (typeof value.toDate === 'function') return value.toDate();
          if (value instanceof Date) return value;
          if (value.seconds != null) return new Date(value.seconds * 1000);
          try { return new Date(value); } catch (e) { return null; }
        }

        function queueRef(locationId) {
          return fs().collection('queues').doc(locationId);
        }

        function membersRef(locationId) {
          return queueRef(locationId).collection('members');
        }

        function memberRef(locationId, docId) {
          return membersRef(locationId).doc(docId);
        }

        function historyRef(locationId) {
          return queueRef(locationId).collection('history');
        }

        function feedbackRef(locationId) {
          return queueRef(locationId).collection('feedback');
        }

        var QUEUE_IDS = ['canteen', 'photostat'];

        // Idempotent bootstrap: make sure both queue documents exist.
        // Safe to call on every app load (matching set, no data loss).
        function seedIfNeeded() {
          if (!isEnabled()) {
            return $q.reject(new Error('Firestore disabled'));
          }
          var writes = QUEUE_IDS.map(function (id) {
            return fs()
              .collection('queues')
              .doc(id)
              .set(
                { count: 0, updatedAt: field().serverTimestamp() },
                { merge: true }
              );
          });
          return wrap(Promise.all(writes));
        }

        // Live subscription. cb(rows) is invoked inside the Angular digest.
        // rows: [{ studentId, joinedAt: Date, request, updatedAt: Date }]
        // sorted by (joinedAt, studentId) — row[0] is "Now Serving".
        function subscribeQueue(locationId, cb) {
          if (!isEnabled()) return null;
          return membersRef(locationId)
            .orderBy('joinedAt', 'asc')
            .onSnapshot(
              function (snapshot) {
                var rows = snapshot.docs.map(function (doc) {
                  var data = doc.data() || {};
                  return {
                    studentId: doc.id,
                    joinedAt: toDate(data.joinedAt),
                    updatedAt: toDate(data.updatedAt),
                    request: data.request || null
                  };
                });
                // Stable secondary sort so identical timestamps never flicker.
                rows.sort(function (a, b) {
                  var t = (a.joinedAt || NaN) - (b.joinedAt || NaN);
                  if (t !== 0) return t;
                  return a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0;
                });
                $timeout(function () { cb(rows); }, 0);
              },
              function (err) {
                console.warn('QueueSync: members snapshot error (' + locationId + ')', err);
              }
            );
        }

        // Live subscription to the feedback collection for a queue.
        // cb(rows): [{ studentId, status, at: Date }]
        function subscribeFeedback(locationId, cb) {
          if (!isEnabled()) return null;
          return feedbackRef(locationId)
            .onSnapshot(
              function (snapshot) {
                var rows = snapshot.docs.map(function (doc) {
                  var data = doc.data() || {};
                  return {
                    studentId: doc.id,
                    status: data.status || null,
                    at: toDate(data.at)
                  };
                });
                $timeout(function () { cb(rows); }, 0);
              },
              function (err) {
                console.warn('QueueSync: feedback snapshot error (' + locationId + ')', err);
              }
            );
        }

        // Transactional join. Returns { found, duplicate, position } where
        // position is 1-based and duplicate=true for a repeat visit.
        function joinQueue(locationId, studentId) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }

          var qRef = queueRef(locationId);
          var mRef = memberRef(locationId, studentId);

          fs()
            .runTransaction(function (tx) {
              var mSnapP = tx.get(mRef);
              var qSnapP = tx.get(qRef);
              return Promise.all([mSnapP, qSnapP]).then(function (results) {
                var mSnap = results[0];
                var qSnap = results[1];
                if (mSnap.exists) {
                  return { found: true, duplicate: true, position: null };
                }
                var count = qSnap.exists ? (qSnap.data().count || 0) : 0;
                var nextCount = count + 1;
                tx.set(
                  qRef,
                  { count: nextCount, updatedAt: field().serverTimestamp() },
                  { merge: true }
                );
                tx.set(mRef, {
                  joinedAt: field().serverTimestamp(),
                  updatedAt: field().serverTimestamp()
                });
                return { found: true, duplicate: false, position: nextCount };
              });
            })
            .then(function (result) {
              deferred.resolve(result);
            })
            .catch(function (err) {
              deferred.reject(err);
            });

          return deferred.promise;
        }

        // Transactional leave. Returns { found } (found=false when the
        // member document was already gone, e.g. already served).
        function leaveQueue(locationId, studentId) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }

          var qRef = queueRef(locationId);
          var mRef = memberRef(locationId, studentId);
          var fbRef = feedbackRef(locationId).doc(studentId);

          fs()
            .runTransaction(function (tx) {
              var mSnapP = tx.get(mRef);
              var qSnapP = tx.get(qRef);
              return Promise.all([mSnapP, qSnapP]).then(function (results) {
                var mSnap = results[0];
                var qSnap = results[1];
                if (!mSnap.exists) {
                  return { found: false };
                }
                var count = qSnap.exists ? (qSnap.data().count || 0) : 0;
                tx.set(
                  qRef,
                  { count: Math.max(0, count - 1), updatedAt: field().serverTimestamp() },
                  { merge: true }
                );
                tx.delete(mRef);
                return { found: true };
              });
            })
            .then(function (result) {
              // Best-effort cleanup of the student's feedback row.
              try { fbRef.delete(); } catch (e) { /* non-fatal */ }
              deferred.resolve(result);
            })
            .catch(function (err) {
              deferred.reject(err);
            });

          return deferred.promise;
        }

        // Attach / update the curated request payload on a member document
        // (e.g. photostat job details). Latest write wins, so a student's
        // confirmation is what the admin card shows.
        function saveRequest(locationId, docId, request) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }
          if (!docId) {
            deferred.reject(new Error('Missing member doc id'));
            return deferred.promise;
          }
          wrap(memberRef(locationId, docId).set(
            { request: request || {}, updatedAt: field().serverTimestamp() },
            { merge: true }
          )).then(
            function () {
              deferred.resolve({ ok: true });
            },
            function (err) {
              deferred.reject(err);
            }
          );
          return deferred.promise;
        }

        // Data-layer serve action. Atomically:
        //   1. loads the OLDEST member (FIFO by joinedAt),
        //   2. copies a snapshot into queues/{loc}/history/{studentId}
        //      (status: 'Served', servedAt: now) for later stats,
        //   3. deletes the member doc, 4. decrements queue count.
        // Returns { studentId, data, request } or null when the queue
        // is empty / the document was already served by someone else.
        function completeRequest(locationId) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }

          var attemptsLeft = 3;

          function attempt() {
            membersRef(locationId)
              .orderBy('joinedAt', 'asc')
              .limit(1)
              .get()
              .then(function (snapshot) {
                if (snapshot.empty) {
                  deferred.resolve(null);
                  return;
                }
                var first = snapshot.docs[0];
                var mRef = memberRef(locationId, first.id);
                var qRef = queueRef(locationId);

                return fs()
                  .runTransaction(function (tx) {
                    var mSnapP = tx.get(mRef);
                    var qSnapP = tx.get(qRef);
                    return Promise.all([mSnapP, qSnapP]).then(function (results) {
                      var mSnap = results[0];
                      if (!mSnap.exists) {
                        return { retry: true };
                      }
                      var data = mSnap.data() || {};
                      var qSnap = results[1];
                      var count = qSnap.exists ? (qSnap.data().count || 0) : 0;

                      // Keep a copy for future stats before deleting.
                      tx.set(historyRef(locationId).doc(first.id), {
                        studentId: first.id,
                        joinedAt: data.joinedAt || null,
                        request: data.request || null,
                        status: 'Served',
                        servedAt: field().serverTimestamp()
                      });

                      tx.delete(mRef);
                      tx.set(
                        qRef,
                        { count: Math.max(0, count - 1), updatedAt: field().serverTimestamp() },
                        { merge: true }
                      );
                      return {
                        retry: false,
                        studentId: first.id,
                        data: data
                      };
                    });
                  })
                  .then(function (result) {
                    if (result.retry) {
                      if (--attemptsLeft > 0) { attempt(); }
                      else { deferred.reject(new Error('Could not serve request (concurrent change).')); }
                      return;
                    }
                    deferred.resolve({
                      studentId: result.studentId,
                      data: result.data,
                      request: (result.data && result.data.request) || null
                    });
                  });
              })
              .catch(function (err) {
                deferred.reject(err);
              });
          }

          attempt();
          return deferred.promise;
        }

        // Best-effort removal of an uploaded file in Firebase Storage so
        // "Serve / Done" cleans up print files. No-op when no gs:// URL or
        // no Storage SDK. Callers catch errors (non-fatal at serve time).
        function deleteStorageFile(url) {
          if (!isEnabled() || !url || typeof String(url) !== 'string') {
            return $q.resolve({ deleted: false });
          }
          var s = String(url);
          if (s.indexOf('gs://') !== 0) {
            return $q.resolve({ deleted: false });
          }
          try {
            if (!window.firebase.storage) {
              return $q.resolve({ deleted: false });
            }
            var storage = window.firebase.storage(window.QueueSyncFirebase.app);
            return wrap(storage.refFromURL(s).delete()).then(function () {
              return { deleted: true };
            });
          } catch (err) {
            console.warn('QueueSync: storage cleanup failed', err);
            return $q.resolve({ deleted: false, error: err });
          }
        }

        // Best-effort upload of an uploaded print file to Firebase Storage.
        // Resolves to [] (never rejects) when Storage is unavailable, so the
        // caller transparently falls back to recording file name/size only.
        // Each result: { name, size, url (gs:// for deletion), previewUrl
        //   (https download link shown on the admin "Now Serving" card) }.
        function uploadFiles(files) {
          var deferred = $q.defer();
          var list = Array.prototype.slice.call(files || []);
          if (!isEnabled() || !list.length || !window.firebase.storage) {
            deferred.resolve([]);
            return deferred.promise;
          }
          try {
            var storage = window.firebase.storage(window.QueueSyncFirebase.app);
            var tasks = list.map(function (file) {
              var safe = String(file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
              var ref = storage.ref(
                'photostat_jobs/' + Date.now() + '-' + Math.floor(100000 + Math.random() * 900000) + '-' + safe
              );
              return ref.put(file)
                .then(function () {
                  return ref.getDownloadURL().then(function (downloadUrl) {
                    return {
                      name: file.name,
                      size: file.size || 0,
                      url: ref.toString(),        // gs:// bucket path -> use with deleteStorageFile
                      previewUrl: downloadUrl     // https link -> admin card "open"
                    };
                  });
                });
            });
            wrap(Promise.all(tasks)).then(
              function (results) { deferred.resolve(results); },
              function (err) {
                console.warn('QueueSync: file upload failed (recording names only).', err);
                deferred.resolve([]);
              }
            );
          } catch (err) {
            console.warn('QueueSync: file upload unavailable.', err);
            deferred.resolve([]);
          }
          return deferred.promise;
        }

        // Data-layer reset: zero the count and clear every member + feedback
        // row for a queue. (Future admin tooling.)
        function resetQueue(locationId) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }

          function wipe(query, refs, done) {
            if (refs.length >= 500) { done(); return; }
            query.get().then(function (snapshot) {
              refs = refs.concat(snapshot.docs.map(function (d) { return d.ref; }));
              if (snapshot.size === 0 || refs.length >= 500) { done(); return; }
              wipe(membersRef(locationId).orderBy('joinedAt').startAfter(snapshot.docs[snapshot.size - 1]), refs, done);
            });
          }

          function wipeFeedback(refs, done) {
            feedbackRef(locationId).get().then(function (snapshot) {
              refs = refs.concat(snapshot.docs.map(function (d) { return d.ref; }));
              done();
            });
          }

          var mRefs = [];
          var fRefs = [];
          Promise.all([
            new Promise(function (resolve) {
              wipe(membersRef(locationId).orderBy('joinedAt'), [], function () { resolve(mRefs); });
            }),
            new Promise(function (resolve) {
              wipeFeedback([], function () { resolve(fRefs); });
            })
          ]).then(function (results) {
            var all = results[0].concat(results[1]);
            if (all.length === 0) {
              return queueRef(locationId).set(
                { count: 0, updatedAt: field().serverTimestamp() },
                { merge: true }
              );
            }
            var batch = fs().batch();
            all.forEach(function (ref) { batch.delete(ref); });
            batch.update(queueRef(locationId), { count: 0, updatedAt: field().serverTimestamp() });
            return batch.commit();
          }).then(function () {
            deferred.resolve({ ok: true });
          }).catch(function (err) {
            deferred.reject(err);
          });

          return deferred.promise;
        }

        // Informational writer: corrects the stored count to a given value.
        function setCount(locationId, n) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }
          wrap(queueRef(locationId).set(
            { count: n, updatedAt: field().serverTimestamp() },
            { merge: true }
          )).then(
            function () { deferred.resolve({ ok: true }); },
            function (err) { deferred.reject(err); }
          );
          return deferred.promise;
        }

        // Write this student's "How was the wait?" status. Last writer wins.
        function updateFeedback(locationId, studentId, statusValue) {
          var deferred = $q.defer();
          if (!isEnabled()) {
            deferred.reject(new Error('Firestore disabled'));
            return deferred.promise;
          }
          var liveRef = feedbackRef(locationId).doc(studentId);
          wrap(liveRef.set(
            { status: statusValue, at: field().serverTimestamp() },
            { merge: true }
          )).then(
            function () {
              // Touch the queue document so open admin dashboards refresh.
              return wrap(queueRef(locationId).set(
                { updatedAt: field().serverTimestamp() },
                { merge: true }
              ));
            },
            function (err) { deferred.reject(err); }
          ).then(
            function () { deferred.resolve({ ok: true }); },
            function (err) { deferred.reject(err); }
          );
          return deferred.promise;
        }

        return {
          isEnabled: isEnabled,
          seedIfNeeded: seedIfNeeded,
          subscribeQueue: subscribeQueue,
          subscribeFeedback: subscribeFeedback,
          joinQueue: joinQueue,
          leaveQueue: leaveQueue,
          saveRequest: saveRequest,
          completeRequest: completeRequest,
          deleteStorageFile: deleteStorageFile,
          uploadFiles: uploadFiles,
          resetQueue: resetQueue,
          setCount: setCount,
          updateFeedback: updateFeedback
        };
      }
    ]);
})();