import { createClient } from "npm:@supabase/supabase-js@2";

// Service-role client: bypasses RLS. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// are injected automatically into every Edge Function.
export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
