# NutriScan · AI Food & Nutrition Tracker

> **Eat smart. Live better.** Tu alimentación, analizada inteligentemente.

App móvil (PWA instalable en Android e iPhone) que fotografía tu plato, identifica los alimentos con **Claude** y calcula los nutrientes **aproximados**, con registro diario, estadísticas, historial con calendario y un asistente de nutrición.

---

## ⚠️ Sobre "vincular tu cuenta de Claude Pro"

**No es posible.** Anthropic no ofrece ningún "Iniciar sesión con Claude" para apps de terceros, y sus condiciones no permiten usar la suscripción Pro/Max de claude.ai fuera de sus propias apps. Si una app lo hiciera, se arriesgaría a que bloqueen la cuenta del usuario.

Lo que sí hace NutriScan, y es lo más parecido que se puede hacer legalmente:

1. El usuario crea su cuenta de NutriScan (email + contraseña) → se guarda en **Supabase** (base de datos individual).
2. En *Perfil → Cuenta de Claude* pega una **API key** de [console.anthropic.com](https://console.anthropic.com/settings/keys). Se entra con la misma cuenta de Claude, pero **el uso se factura aparte** (prepago, desde 5 $).
3. El servidor valida la clave contra Anthropic, la **cifra con AES-256-GCM** y la guarda en una tabla que el navegador no puede leer. La app nunca vuelve a ver la clave.

Coste orientativo con el modelo por defecto (`claude-opus-5-5`): **unos 3–5 céntimos por foto** y alrededor de 1 céntimo por mensaje del chat. Si quieres abaratarlo, define el secreto `CLAUDE_MODEL=claude-sonnet-5-5` (aproximadamente la mitad).

> Alternativa para cuando tengas usuarios reales: que la clave sea **tuya** (la de tu empresa) y cobres una suscripción. Así el usuario no tiene que crear nada en la consola de Anthropic. Cambiarlo es sencillo: en `userClient()` se usaría un secreto del servidor en lugar de la clave del usuario.

---

## Arquitectura

```
Móvil (PWA: index.html)                 Supabase
 ├─ Auth (email/contraseña)  ─────────▶ auth.users
 ├─ Datos (RLS por usuario)  ─────────▶ profiles · meals · water_logs
 ├─ Fotos privadas           ─────────▶ Storage "meal-photos/{uid}/…"
 └─ IA (JWT del usuario)     ─────────▶ Edge Function "nutriscan-ai"
                                           ├─ descifra la clave del usuario
                                           ├─ Claude (visión + JSON estructurado)
                                           └─ USDA FoodData Central (opcional)
```

| Archivo | Qué es |
|---|---|
| `index.html` | La app completa (HTML + CSS + JS en un solo archivo). |
| `config.js` | URL y anon key de Supabase (públicas). |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalación como app y funcionamiento offline del shell. |
| `supabase/migrations/…_init.sql` | Tablas, políticas RLS, bucket de fotos y triggers. |
| `supabase/functions/nutriscan-ai/index.ts` | API segura: claves, análisis de fotos, búsqueda de alimentos, chat y borrado de cuenta. |

**Cálculo nutricional:** Claude identifica cada alimento, estima los gramos y propone un término de búsqueda. Si configuras `FDC_API_KEY`, el servidor busca los valores por 100 g en **USDA FoodData Central** (base de datos pública y fiable) y solo usa la estimación de la IA si no hay coincidencia razonable. Cada alimento muestra su origen («USDA» o «Estimación IA») y siempre se presenta como **aproximado**.

**Sin IA configurada** la app lo dice claramente («pendiente») y no simula resultados: puedes registrar comidas a mano.

---

## Puesta en marcha (≈ 20 min, coste 0 €)

### 1. Supabase
1. Crea un proyecto en [supabase.com](https://supabase.com) → región **EU (Frankfurt o París)**.
2. *SQL Editor* → pega y ejecuta `supabase/migrations/20261108000000_init.sql`.
3. *Authentication → URL Configuration*: pon la URL donde publicarás la app en **Site URL** y **Redirect URLs**.
4. *Project Settings → API*: copia la **Project URL** y la **anon/publishable key** en `config.js`.

### 2. Función de IA
Instala la [CLI de Supabase](https://supabase.com/docs/guides/cli) y, desde la carpeta del proyecto:

```bash
supabase login
```

```bash
supabase link --project-ref TU_PROJECT_REF
```

```bash
supabase secrets set NUTRISCAN_KEY_SECRET="$(openssl rand -base64 48)"
```

Opcional (recomendado para datos más fiables; la clave es gratuita en [fdc.nal.usda.gov/api-key-signup](https://fdc.nal.usda.gov/api-key-signup)):

```bash
supabase secrets set FDC_API_KEY=tu_clave_usda
```

```bash
supabase functions deploy nutriscan-ai
```

> ⚠️ No cambies `NUTRISCAN_KEY_SECRET` después: las claves ya guardadas dejarían de poder descifrarse y los usuarios tendrían que volver a conectarlas.

Cuando tengas dominio propio, limita CORS con `supabase secrets set ALLOWED_ORIGIN=https://tudominio.com`.

### 3. Publicar la app
Es un sitio estático: sirve la carpeta raíz en **GitHub Pages**, **Netlify** o **Vercel** (las tres tienen plan gratuito y HTTPS, que es obligatorio para la cámara y para instalar la PWA).

Para probarla en local:

```bash
python3 -m http.server 8080
```

### 4. Instalar en el móvil
- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** Compartir → *Añadir a pantalla de inicio*.
- **Play Store:** genera el paquete con [PWABuilder](https://www.pwabuilder.com) a partir de la URL publicada (cuenta de desarrollador de Google: 25 $ una sola vez). Si más adelante necesitas funciones nativas, se puede envolver con Capacitor sin rehacer la interfaz.

---

## Funciones

- **Inicio:** anillo de energía, objetivo orientativo, margen sin lenguaje de restricción, proteínas, carbohidratos, grasas, fibra, agua, número de comidas y un mensaje positivo del día.
- **Escanear mi plato:** cámara o galería → compresión en el móvil → análisis con indicador de progreso → resultados editables (nombre, gramos, añadir/eliminar alimentos, recalcular) con energía, proteínas, carbohidratos, grasas, saturadas, fibra, azúcares y sodio.
- **Registro:** desayuno, comida, merienda y cena con foto, fecha y hora; editar y eliminar; el dashboard se actualiza solo.
- **Historial:** calendario mensual con días marcados, resumen de cada día, galería de fotos y posibilidad de añadir comidas a días anteriores.
- **Mi nutrición:** 7/30 días, energía diaria frente al objetivo, reparto de macronutrientes, fibra, hidratación, variedad de alimentos y fichas educativas.
- **NutriScan AI:** chat que conoce tu perfil, tus alergias y lo que has comido hoy; educativo, sin juicios y sin dietas restrictivas.
- **Perfil:** alias, edad, preferencias, 14 alérgenos UE, gustos, actividad, objetivos y sugerencia orientativa (Mifflin-St Jeor) **solo para adultos sin condición médica**. Para menores o personas con necesidades médicas no se calculan objetivos ni se ofrece «perder peso», y se recomienda acudir a un profesional.
- **Extras:** bienvenida y tutorial, modo oscuro, recordatorios, exportar datos (JSON) y eliminar cuenta, y un modo local sin cuenta para probar la app.

### Pendiente (no se simula)
- **Notificaciones push con la app cerrada:** requieren un servidor de envío (Web Push + VAPID). Ahora funcionan con la app abierta o en segundo plano.
- **Inicio de sesión con Google/Apple:** se puede activar en Supabase Auth cuando lo necesites.

---

## Requisitos legales en España (antes de publicarla)

- **RGPD art. 9:** los registros de alimentación pueden revelar datos de salud (categoría especial). La app ya pide **consentimiento expreso** al registrarse; guarda la fecha en `profiles.health_consent_at`.
- **LOPDGDD:** la edad mínima para consentir es de **14 años**. Está exigida en el registro y en la base de datos.
- **Política de privacidad y aviso legal** con tus datos como responsable (nombre/NIF, email de contacto, finalidades, plazos y derechos). El texto del apartado «Protección de datos» de la app es solo un resumen.
- **Encargados del tratamiento:** Supabase y Anthropic. Firma o acepta sus DPA y menciona la **transferencia internacional** a EE. UU. (Anthropic) en la política.
- **No es un producto sanitario:** no diagnostiques ni prometas resultados de salud. Si añadieras recomendaciones clínicas personalizadas, podría entrar en el reglamento europeo de productos sanitarios (MDR).
- **LSSI:** si cobras (suscripción) o pones publicidad, tendrás que darte de alta como autónomo o facturar desde tu actividad (por ejemplo, AUTOMATIA) e incluir el aviso legal LSSI.

## Límites del plan gratuito de Supabase
Proyectos pausados tras 7 días sin actividad, 500 MB de base de datos y 1 GB de Storage. Las fotos se comprimen a ~150–250 KB, así que caben unas 4.000–6.000.
