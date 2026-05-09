import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Missing Supabase URL or ANON key in environment variables.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function uploadFrame(file: Blob, path: string) {
  // If running in the browser, call the Edge Function which uses the service_role key.
  if (typeof window !== "undefined") {
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file as Blob);
      });

      const projectUrl = supabaseUrl;
      const functionsUrl = projectUrl.replace(".supabase.co", ".functions.supabase.co");
      const resp = await fetch(`${functionsUrl}/upload-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: path, data: base64 }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { error: new Error(`Edge function upload failed: ${text}`) } as any;
      }

      return { data: await resp.json() } as any;
    } catch (err) {
      console.error("uploadFrame via Edge Function failed:", err);
      // fallback to direct client upload
    }
  }

  // Server-side or fallback: Use upsert to avoid failures when the same filename exists.
  const res = await supabase.storage.from("frames").upload(path, file, { cacheControl: "3600", upsert: true });
  if (res.error) {
    console.error("Supabase storage upload error:", res.error);
  }
  return res;
}

export async function logEvent(eventType: string, metadata?: Record<string, unknown>) {
  return supabase.from("events").insert({ event_type: eventType, metadata });
}

export async function incrementCounter(name: string) {
  try {
    return supabase.rpc("increment_counter", { counter_name: name });
  } catch (err) {
    console.error("incrementCounter error", err);
    return null;
  }
}
