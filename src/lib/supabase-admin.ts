import { createClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import WebSocket from "ws";

const realtimeTransport = WebSocket as unknown as WebSocketLikeConstructor;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error(
    "Missing Supabase admin environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY."
  );
}

export const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseSecretKey,
  {
    auth: {
      persistSession: false,
    },
    realtime: {
      transport: realtimeTransport,
    },
  }
);
