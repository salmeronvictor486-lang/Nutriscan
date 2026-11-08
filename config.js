// NutriScan · configuración pública del frontend.
// La URL y la "anon key" de Supabase son públicas por diseño (la seguridad la dan las políticas RLS).
// NUNCA pongas aquí claves privadas (service_role, API keys de Claude, USDA…).
window.NUTRISCAN_CONFIG = {
  SUPABASE_URL: "",        // p. ej. "https://abcd1234.supabase.co"
  SUPABASE_ANON_KEY: "",   // Project Settings → API → anon / publishable key
  FUNCTION_NAME: "nutriscan-ai",
};
