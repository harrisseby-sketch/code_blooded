/* ============================================
   QueueSync - Supabase config (multi-device sync)
   --------------------------------------------
   1. Copy this file -> js/supabase-config.js (same folder).
   2. Paste your free Supabase project URL + anon key below.
   3. Reload the app on every device. The admin sync panel will
      show "Live multi-device sync" and the Food orders count
      updates the moment ANY device checks out.

   js/supabase-config.js is git-ignored so keys never get committed.
   ============================================ */

window.QueueSyncConfig = {
  supabaseUrl: 'https://earwvnvcwwngqxnlrvin.supabase.co/rest/v1/',       // e.g. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhcnd2bnZjd3duZ3F4bmxydmluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NzkzNzksImV4cCI6MjEwNTM1NTM3OX0.5lIAVG4C6d1dFGKahudAGQIvyMI9CFTeLu4AwyW_h3M'
};
