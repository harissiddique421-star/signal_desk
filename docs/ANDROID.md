# Android: what exists now, and the native phase

## Now: installable PWA (implemented)

Signal Desk ships a web app manifest (`src/app/manifest.ts`), icons (including a maskable icon) and a small service worker (`public/sw.js`). On Android Chrome, open the deployed HTTPS site and choose **Install app** / **Add to Home screen**. It then opens full-screen like an app.

What the PWA does **not** do:

- It is not a native APK and is not on the Play Store.
- It does not run in the background. Alerts sound only while the page is open in the foreground.
- The service worker caches the app shell only. Market data and API responses are never cached, so an offline app says it is offline instead of showing stale prices.

## Later phase: native Android app (not started)

Options, in increasing effort:

1. **Trusted Web Activity (TWA)** with Bubblewrap — wraps the PWA in a Play-Store-installable APK. Requires Digital Asset Links on the domain.
2. **Capacitor** shell around the web app — adds native plugins (local notifications, background fetch).
3. **Fully native** (Kotlin) client against the same `/api/*` endpoints.

Background alerts need server push (Web Push or FCM) driven by a scheduled server job that runs the analysis each minute — that is a separate backend piece (a cron worker plus a push subscription table) and is not built yet.

Store policy note: Google Play restricts apps related to binary options in many regions. Check the current Play policy and local regulations before publishing.
