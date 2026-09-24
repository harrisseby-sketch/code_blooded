/* ============================================
   QueueSync - Firebase Configuration
   Compat SDK initialisation with graceful fallback.

   Exposes:
     window.QueueSyncFirebase = {
       app      : the Firebase app (null if unavailable),
       db       : the Firestore instance (null if unavailable),
       enabled  : true when the Firestore link is usable,
       mode     : 'cloud' when enabled, otherwise 'demo',
       error    : reason string when falling back
     }

   The project config below is the public web API key (safe to ship
   in a client; Firebase security is enforced by Firestore rules).
   ============================================ */

(function () {
  'use strict';

  var state = {
    app: null,
    db: null,
    enabled: false,
    mode: 'demo',
    error: null
  };

  try {
    // The compat SDK must be loaded before this file runs.
    if (
      !window.firebase ||
      typeof window.firebase.initializeApp !== 'function' ||
      !window.firebase.firestore
    ) {
      state.error =
        'Firebase compat SDK unavailable (script not loaded / offline?). ' +
        'Falling back to local demo mode.';
    } else {
      var firebaseConfig = {
        apiKey: 'AIzaSyD3rZ6gBuTUt0Wo81F3R0EOto0BxGEI-i0',
        authDomain: 'dbque-c1d95.firebaseapp.com',
        projectId: 'dbque-c1d95',
        storageBucket: 'dbque-c1d95.firebasestorage.app',
        messagingSenderId: '580737876725',
        appId: '1:580737876725:web:38c48791a33f480b95bbbc',
        measurementId: 'G-9L0D3MDEVC'
      };

      var app = window.firebase.initializeApp(firebaseConfig);
      var db = window.firebase.firestore(app);

      state.app = app;
      state.db = db;
      state.enabled = true;
      state.mode = 'cloud';
    }
  } catch (err) {
    state.app = null;
    state.db = null;
    state.enabled = false;
    state.mode = 'demo';
    state.error = (err && err.message) ? err.message : String(err);
  }

  window.QueueSyncFirebase = state;
})();