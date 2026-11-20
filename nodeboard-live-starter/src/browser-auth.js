import { createClient } from '@supabase/supabase-js';

window.createNodeboardAuth = (url, key) => createClient(url, key, {
  auth: { flowType: 'pkce', autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
});
