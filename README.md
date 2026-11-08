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
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalación como app (PWA), atajos, capturas y funcionamiento offline del shell. |
| `android/`, `capacitor.config.json`, `package.json` | Proyecto Android nativo (Capacitor 8) que empaqueta la misma app. |
| `.github/workflows/` | Publicación automática de la web y del APK. |
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

### 3. Publicar la app (automático con GitHub)
Al fusionar en `main`, dos flujos de GitHub Actions lo hacen todo solos:

| Flujo | Qué hace | Resultado |
|---|---|---|
| `pages.yml` | Publica la web | `https://salmeronvictor486-lang.github.io/Nutriscan/` |
| `android.yml` | Compila el APK de Android | `…/releases/download/android-latest/NutriScan.apk` |

Hay que hacer **una sola vez**: *Settings → Pages → Source: GitHub Actions*. Si el repositorio es privado, GitHub Pages necesita un plan de pago y las descargas de la release requieren iniciar sesión: hazlo **público** (las claves no están en el código, así que es seguro) o publica la web en Netlify o Vercel.

Esas dos URL ya vienen en `config.js` (`APP_URL` y `ANDROID_APK_URL`). Si cambias de hosting, actualízalas.

Para probarla en local:

```bash
python3 -m http.server 8080
```

---

## 📱 Instalar en el móvil

Comparte **un solo enlace** (o el QR que la web muestra en el ordenador). La app detecta el móvil y enseña los pasos adecuados.

### iPhone (sin App Store)
1. Abre el enlace en Safari (o Chrome/Edge, con iOS 16.4 o posterior).
2. Pulsa **Compartir**, que en iOS 26 está dentro del botón `···`, y luego **Añadir a pantalla de inicio**.
3. Listo: se abre a pantalla completa con su icono, igual que una app.

Si el enlace se abre dentro de Instagram o WhatsApp, la app avisa de que hay que abrirlo antes en Safari.

### Android
- **Desde Chrome:** botón **Instalar** dentro de la app, o menú ⋮ y después *Instalar aplicación*. Es la opción recomendada.
- **APK:** descarga `NutriScan.apk` desde la release `android-latest`, ábrelo y permite «instalar apps de este origen». Cada versión nueva se instala encima sin perder datos.

Extras incluidos:
- Atajo **«Escanear mi plato»** manteniendo pulsado el icono (Android).
- Capturas en el diálogo de instalación de Android.
- Iconos adaptativos y pantalla de carga con la marca.

### ¿Y las tiendas oficiales?
| | Requisitos | Cómo |
|---|---|---|
| **Google Play** | Cuenta de desarrollador (25 $, pago único). Para cuentas personales nuevas, prueba cerrada con 12 testers durante 14 días. | Crea tu propia clave de firma (no uses `nutriscan-test.keystore`) y genera el AAB con `cd android && ./gradlew bundleRelease`. |
| **App Store** | Apple Developer Program (99 $/año) y un Mac con Xcode, o un servicio de compilación en la nube. | `npm i -D @capacitor/ios@8.5.3 && npx cap add ios && npm run ios:open`. Apple puede rechazar apps que sean «solo una web»: conviene añadir algo nativo antes (por ejemplo notificaciones). |

Mi consejo con poco presupuesto: empieza con la **PWA en iPhone** y la **PWA o el APK en Android** (coste 0 €). Pasa a las tiendas cuando tengas usuarios que lo pidan.

### Proyecto nativo (Capacitor)
`android/` contiene el proyecto Android listo para abrir en Android Studio:

```bash
npm install
```

```bash
npm run android:open
```

La app nativa carga el mismo `index.html`, así que cualquier cambio en la web llega al APK en la siguiente compilación.

> ⚠️ `android/app/nutriscan-test.keystore` es una clave **de pruebas** pública, pensada para que el APK de GitHub se pueda actualizar sin desinstalar. Para Google Play usa una clave privada propia y no la subas al repositorio.

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
