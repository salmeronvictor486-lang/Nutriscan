// NutriScan · configuración pública del frontend.
// La URL y la "anon key" de Supabase son públicas por diseño (la seguridad la dan las políticas RLS).
// NUNCA pongas aquí claves privadas (service_role, API keys de Claude, USDA…).
window.NUTRISCAN_CONFIG = {
  SUPABASE_URL: "",        // p. ej. "https://abcd1234.supabase.co"
  SUPABASE_ANON_KEY: "",   // Project Settings → API → anon / publishable key
  FUNCTION_NAME: "nutriscan-ai",

  // Instalación en el móvil
  APP_URL: "https://salmeronvictor486-lang.github.io/Nutriscan/", // URL pública de la app, p. ej. "https://usuario.github.io/Nutriscan/"
                           // (se usa para compartir, el QR y los enlaces de los emails; obligatoria en la app nativa)
  ANDROID_APK_URL: "https://github.com/salmeronvictor486-lang/Nutriscan/releases/download/android-latest/NutriScan.apk",
};
