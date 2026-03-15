/**
 * App.js — Main Vue 3 PWA Application Entry Point
 *
 * Rewritten from minified source for clarity, maintainability, and readability.
 * Original: gatheringashenblood.shop/assets/App-v431.js
 */

// ─────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────

import {
  getCookie,
  PushStatus,
  setCookie,
  SW_PATH,
  urlBase64ToUint8Array,
  NumberFormat,
  trackEvent,
  ENV,
  STAGE_USER_ID,
  STAGE_HOSTNAME,
  STORE_PATH,
  shuffleComments,
  CALLBACK_BASE_URL,
  PWA_UUID_KEY,
  preconnectLink,
  EventNames,
  getBrowserIntentUrl,
  getRedirectUrl,
  getFacebookIntentUrl,
  OPEN_URL,
  ErrorCodes,
  useErrorHandler,
  ScrollKeys,
  trackHit,
  ServiceWorkerKeys,
  checkWebApk,
} from "./index-v431.js";

import { useRouter } from "./vue-router-v431.js";

import {
  ref,
  computed,
  defineAsyncComponent,
  watch,
  onMounted,
  onUnmounted,
  defineComponent,
  withDirectives,
  resolveDirective,
  createVNode,
  createTextVNode,
  Fragment,
  Comment,
  resolveDynamicComponent,
  provide,
} from "./vue-core-v431.js";

import { useScrollDirection } from "./useFormatting-v431.js";

// Static assets
const SAMSUNG_BROWSER_LOGO = "/assets/samsung_browser_logo.webp";
const CHROME_LOGO         = "/assets/google_chrome_logo.webp";

// Preland aliases → async component map
import { PrelandAliases, FinalActions }  from "./index-v431.js";
import { ChickenRoadComponent }          from "./ChickenRoadComponent-v431.js";
import { ChickenRoad2Component }         from "./ChickenRoad2Component-v431.js";

const PRELAND_REGISTRY = {
  [PrelandAliases.CHICKEN_ROAD]:  () => import("./ChickenRoadComponent-v431.js").then(m => m.ChickenRoadComponent),
  [PrelandAliases.CHICKEN_ROAD_2]:() => import("./ChickenRoad2Component-v431.js").then(m => m.ChickenRoad2Component),
};


// ─────────────────────────────────────────────
// Composable: useIndexedDBConfig
// Persists push config to IndexedDB
// ─────────────────────────────────────────────

function openConfigDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pushConfigDB", 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("config")) {
        db.createObjectStore("config", { keyPath: "key" });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror   = (event) => reject(event.target.error);
  });
}

async function savePushConfig(config) {
  const db = await openConfigDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("config", "readwrite");
    const store       = transaction.objectStore("config");
    const request     = store.put(config);
    request.onsuccess = () => resolve();
    request.onerror   = (e) => reject(e.target.error);
  });
}


// ─────────────────────────────────────────────
// Composable: usePushNotifications
// Initialises VAPP push config and handles subscription
// ─────────────────────────────────────────────

const appIdMeta     = document.querySelector('meta[name="va_app_id"]');
const appKeyMeta    = document.querySelector('meta[name="va_app_public_key"]');

const VA_APP_ID         = appIdMeta?.getAttribute("content");
const VA_APP_PUBLIC_KEY = appKeyMeta?.getAttribute("content");

const cookieAppId  = getCookie("va_app_id");
const cookieAppKey = getCookie("va_app_public_key");

let pushStatus = PushStatus.NOT_DEFINED;

if (VA_APP_ID && VA_APP_PUBLIC_KEY) {
  if (!cookieAppId || !cookieAppKey) {
    setCookie("va_app_id",         VA_APP_ID,         365);
    setCookie("va_app_public_key", VA_APP_PUBLIC_KEY, 365);

    const pushConfig = {
      key:             "pushConfig",
      user_id:         getCookie("user_id") || "",
      vapp_id:         VA_APP_ID,
      va_app_public_key: VA_APP_PUBLIC_KEY,
      language:        navigator.language,
      timezone:        Intl.DateTimeFormat().resolvedOptions().timeZone,
      hostname:        window.location.hostname,
    };

    savePushConfig(pushConfig);
  }

  pushStatus = PushStatus.VAPP;
}

/**
 * @param {Function} sendEvent   — function to fire an analytics event
 * @param {Function} onSubscribe — callback receiving the PushSubscription
 */
function usePushNotifications(sendEvent, onSubscribe) {
  async function _subscribe() {
    if (localStorage.getItem("subscribedToPush")) return;
    if (!("serviceWorker" in navigator))           return;

    const publicKey    = getCookie("va_app_public_key");
    const registration = await navigator.serviceWorker.register(SW_PATH);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    onSubscribe(subscription);
    await sendEvent("push");
    localStorage.setItem("subscribedToPush", "true");
  }

  async function requestPushPermission() {
    if (pushStatus !== PushStatus.VAPP) return;

    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") await _subscribe();
      if (permission === "denied")  await sendEvent("npush");
    } catch (error) {
      console.error("Push permission error:", error);
    }
  }

  return { requestPushPermission };
}


// ─────────────────────────────────────────────
// Composable: useServiceWorkerMessenger
// Queues + delivers messages to the active SW
// ─────────────────────────────────────────────

const RETRY_INTERVAL_MS = 2000;
const pendingMessages   = new Map();
let   retryIntervalId   = null;

async function flushPendingMessages() {
  if (pendingMessages.size === 0) return;

  if (!("serviceWorker" in navigator)) {
    console.warn("Service Worker not supported — clearing pending messages");
    pendingMessages.clear();
    return;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (!registration?.active) return;

    for (const [id, message] of pendingMessages.entries()) {
      try {
        const payload = _normaliseSubscriptionPayload(message);
        registration.active.postMessage({ action: message.action, payload });
        pendingMessages.delete(id);
      } catch (err) {
        console.error(`Failed to send queued message (id=${id}):`, err);
      }
    }

    if (pendingMessages.size === 0) stopRetryInterval();
  } catch (err) {
    console.error("Error flushing pending SW messages:", err);
  }
}

function _normaliseSubscriptionPayload(message) {
  if (
    message.action === "sendVappSubscription" &&
    message.payload?.subscription
  ) {
    return { ...message.payload, subscription: message.payload.subscription.toJSON() };
  }
  return message.payload;
}

function startRetryInterval() {
  if (retryIntervalId === null) {
    retryIntervalId = window.setInterval(flushPendingMessages, RETRY_INTERVAL_MS);
  }
}

function stopRetryInterval() {
  if (retryIntervalId !== null) {
    clearInterval(retryIntervalId);
    retryIntervalId = null;
  }
}

async function postMessageToSW(action, payload) {
  if (!("serviceWorker" in navigator)) {
    console.warn("Service Worker not supported");
    return;
  }

  const registration = await navigator.serviceWorker.register(SW_PATH);

  if (registration.active) {
    // Deliver any previously queued messages first
    if (pendingMessages.size > 0) {
      for (const [id, msg] of pendingMessages) {
        registration.active.postMessage({ action: msg.action, payload: msg.payload });
        pendingMessages.delete(id);
      }
    }

    const normalisedPayload = _normaliseSubscriptionPayload({ action, payload });
    registration.active.postMessage({ action, payload: normalisedPayload });
    return;
  }

  // SW not yet active — queue the message
  const id = Date.now();
  pendingMessages.set(id, { action, payload });
  startRetryInterval();
  console.warn(`SW not active — message queued (id=${id})`);
}


// ─────────────────────────────────────────────
// Composable: usePwaAppData
// Fetches app info, analytics, and event helpers
// ─────────────────────────────────────────────

function usePwaAppData() {
  const app           = ref(_defaultAppState());
  const pwaInfoLoaded = ref(false);

  const { standardizeError, handleStandardizedError } = useErrorHandler();

  /** Apply server response to reactive state */
  function applyAppData(data) {
    app.value = data;
    app.value.comments.forEach(comment => {
      comment.is_liked    = false;
      comment.is_disliked = false;
    });
    app.value.comments = shuffleComments(app.value.comments);
    pwaInfoLoaded.value = true;

    localStorage.setItem("offer",   app.value.offer);
    localStorage.setItem("appIcon", app.value.icon.link);

    document.title = app.value.name;
    document.querySelector('meta[name="description"]')
      ?.setAttribute("content", app.value.descr);
  }

  /** Fetch with automatic exponential-backoff retry */
  async function fetchWithRetry(url, options, maxRetries = 3, delayMs = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);
        if (response.ok) return response;
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client error: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        if (attempt === maxRetries) {
          const standardError = standardizeError("API_RETRY_FAILED", err, {
            url,
            method: options.method,
          });
          handleStandardizedError(standardError);
          throw err;
        }
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error("Retry limit reached");
  }

  function _resolveCredentials() {
    const userId   = ENV === "stage" ? STAGE_USER_ID   : getCookie("user_id");
    const hostname = ENV === "stage" ? STAGE_HOSTNAME  : window.location.hostname;
    return { userId, hostname };
  }

  async function fetchAppFromApi() {
    const { userId, hostname } = _resolveCredentials();

    try {
      const cachedOffer  = localStorage.getItem("offer");
      let   referrerHost = null;
      if (cachedOffer) {
        try { referrerHost = new URL(cachedOffer).hostname; } catch {}
      }

      const headers = {
        ...(userId       && { "cf-ew-wai": userId }),
        ...(referrerHost && { "ddm": referrerHost }),
      };

      const response = await fetchWithRetry(
        `https://${hostname}/pwa_info`,
        { method: "GET", headers }
      );
      const data = await response.json();
      applyAppData(data);
    } catch (err) {
      console.error("fetchAppFromApi failed:", err);
    }
  }

  async function sendAnalyticsToServer(key, value) {
    const { userId, hostname } = _resolveCredentials();
    const headers = {
      "Content-Type": "application/json",
      ...(userId && { "cf-ew-wai": userId }),
    };

    await fetchWithRetry(
      `https://${hostname}/analytics`,
      { method: "POST", headers, body: JSON.stringify({ [key]: value }) }
    );
  }

  async function sendEventToServer(eventName) {
    const { userId, hostname } = _resolveCredentials();
    const headers = {
      ...(userId && { "cf-ew-wai": userId }),
      "cf-ev-wai": eventName,
    };

    await fetchWithRetry(
      `https://${hostname}/event`,
      { method: "HEAD", headers }
    );
  }

  return {
    app,
    pwaInfoLoaded,
    fetchAppFromApi,
    applyAppData,
    sendAnalyticsToServer,
    sendEventToServer,
  };
}

/** Returns the default shape for the `app` reactive object */
function _defaultAppState() {
  return {
    name:               "",
    developer:          "",
    approved:           true,
    have_ads:           true,
    have_purchase:      true,
    editor_choice:      true,
    age:                15,
    rating:             5.123,
    number_of_reviews:  123,
    number_of_downloads:12345,
    por_5: 95, por_4: 4, por_3: 1, por_2: 0, por_1: 0,
    descr:       "",
    vers:        "",
    last_update: 1706704304,
    la_adapt:    false,
    la_days:     0,
    rav:         "",
    ie:          "",
    release:     321,
    whats_new:   "",
    google: "", yandex: "", facebook: "", tiktok: "",
    categories:  [],
    comments:    [],
    pictures:    [],
    icon: { link: localStorage.getItem("appIcon") || "" },
    static_text: _defaultStaticText(),
    offer: "",
  };
}

function _defaultStaticText() {
  return {
    td: false,
    numbers: NumberFormat.WESTERN,
    install_btn: "", open_btn: "", installing_str: "...",
    app_available_str: "", app_not_available: "",
    helpful_info_str: "", yes_str: "", no_str: "",
    all_reviews_str: "", gift_cards_str: "", use_bonus_str: "",
    refund_policy_str: "", children_and_family_str: "",
    guide_for_parents_str: "", terms_of_use_str: "",
    confidentiality_str: "", about_google_play_str: "",
    for_developers_str: "", vat_prices_str: "",
    developer_str: "", have_ads_str: "", have_purchase_str: "",
    editor_choice_str: "", age_restriction_str: "",
    last_update_str: "", version_str: "", description_str: "",
    ie_str: "", rav_str: "", release_str: "", whats_new_str: "",
    data_safety_str: "", data_security: "", data_transfer: "",
    data_collection: "", data_encryption: "", deleting_data: "",
    number_of_reviews_str: "", rating_str: "", number_of_downloads_str: "",
    rating_and_reviews_str: "", rating_and_reviews_verif_str: "",
    parental_controls_required: "",
    tousand: "K", mill: "M",
    m1:"",m2:"",m3:"",m4:"",m5:"",m6:"",
    m7:"",m8:"",m9:"",m10:"",m11:"",m12:"",
  };
}


// ─────────────────────────────────────────────
// Composable: useAssetPreloader
// Preloads images and fonts before showing the store UI
// ─────────────────────────────────────────────

const ANDROID_FONTS = [
  "/assets/GoogleSans-Medium.woff2",
  "/assets/Roboto-Regular.woff2",
  "/assets/GoogleSans-Regular.woff2",
];

const IOS_FONTS = [
  "/assets/SF-Pro-Display-Regular.woff2",
  "/assets/SF-Pro-Display-Medium.woff2",
  "/assets/SF-Pro-Display-Bold.woff2",
];

function useAssetPreloader(platform) {
  const state = ref({
    isPreloading:     false,
    isPreloaded:      false,
    preloadedImages:  0,
    totalImages:      0,
    preloadedFonts:   0,
    totalFonts:       0,
  });

  const fonts = platform.isIOS ? IOS_FONTS : ANDROID_FONTS;

  function preloadImage(url, description = "image") {
    return new Promise(resolve => {
      const img    = new Image();
      img.onload  = () => { state.value.preloadedImages++; resolve(); };
      img.onerror = () => {
        state.value.preloadedImages++;
        console.warn(`⚠️ Failed to load ${description}: ${url}`);
        resolve();
      };
      img.src = url;
    });
  }

  async function preloadImages(appData) {
    const targets = [];

    if (appData.icon?.link) {
      targets.push({ url: appData.icon.link, description: "App icon" });
    }

    appData.pictures?.forEach((pic, i) => {
      targets.push({ url: pic.picture, description: `Gallery image ${i + 1}` });
    });

    state.value.totalImages     = targets.length;
    state.value.preloadedImages = 0;

    if (targets.length === 0) return;

    await Promise.all(
      targets.map(({ url, description }) => preloadImage(url, description))
    );
  }

  function preloadFont(href) {
    return new Promise(resolve => {
      if (document.querySelector(`link[href="${href}"]`)) {
        state.value.preloadedFonts++;
        resolve();
        return;
      }

      const link       = document.createElement("link");
      link.rel         = "preload";
      link.as          = "font";
      link.type        = "font/woff2";
      link.crossOrigin = "anonymous";
      link.href        = href;

      link.onload  = () => { state.value.preloadedFonts++; resolve(); };
      link.onerror = () => {
        state.value.preloadedFonts++;
        console.warn(`⚠️ Failed to load font: ${href}`);
        resolve();
      };

      document.head.appendChild(link);
    });
  }

  async function preloadFonts() {
    state.value.totalFonts     = fonts.length;
    state.value.preloadedFonts = 0;
    await Promise.all(fonts.map(preloadFont));
  }

  async function preloadStoreComponent() {
    try {
      if (platform.isIOS) {
        await import("./AppStoreComponent-v431.js");
      } else {
        await import("./MarketPageComponent-v431.js");
      }
    } catch (err) {
      console.error("Failed to preload store component:", err);
    }
  }

  async function startPreloading(appData) {
    if (state.value.isPreloading || state.value.isPreloaded) return;
    if (!appData) {
      console.warn("⚠️ No app data available for preloading");
      return;
    }

    state.value.isPreloading = true;
    try {
      await Promise.all([
        preloadStoreComponent(),
        preloadImages(appData),
        preloadFonts(),
      ]);
      state.value.isPreloaded = true;
    } catch (err) {
      console.error("❌ Preloading failed:", err);
    } finally {
      state.value.isPreloading = false;
    }
  }

  const isPreloading = computed(() => state.value.isPreloading);
  const isPreloaded  = computed(() => state.value.isPreloaded);

  const progress = computed(() => {
    const total   = state.value.totalImages + state.value.totalFonts + 1;
    const loaded  =
      state.value.preloadedImages +
      state.value.preloadedFonts +
      (state.value.isPreloaded ? 1 : 0);
    return total > 0 ? (loaded / total) * 100 : 0;
  });

  function shouldPreload(finalAction) {
    return finalAction === FinalActions.REDIRECT_TO_STORE;
  }

  return { state, isPreloading, isPreloaded, progress, startPreloading, shouldPreload };
}


// ─────────────────────────────────────────────
// Main App Component
// ─────────────────────────────────────────────

export const App = defineComponent({
  name: "App",

  setup() {
    // ── Core composables ──────────────────────
    const {
      app,
      pwaInfoLoaded,
      applyAppData,
      fetchAppFromApi,
      sendAnalyticsToServer,
      sendEventToServer,
    } = usePwaAppData();

    const { handleStandardizedError, standardizeError } = useErrorHandler();
    const router     = useRouter();
    const { isScrollingDown } = useScrollDirection();

    // ── Async component definitions ───────────
    const MarketPageComponent  = defineAsyncComponent(() => import("./MarketPageComponent-v431.js"));
    const AppStoreComponent    = defineAsyncComponent(() => import("./AppStoreComponent-v431.js"));
    const BottomSheetComponent = defineAsyncComponent(() => import("./BottomSheetComponent-v431.js"));

    // ── Reactive state ────────────────────────
    const activePrelandComponent  = ref(null);
    const preland                 = ref(null);
    const prelandEnabled          = ref(false);
    const beforeInstallPromptEvt  = ref(null);
    const browserChooserOpen      = ref(false);

    const isFromGamePage     = ref(false);
    const isStandaloneMode   = ref(false);
    const isOnPwaUrl         = ref(false);
    const pushPermissionDone = ref(false);

    const progressBarRef     = ref(null);
    const visibilityCounter  = ref(0);

    const serviceWorkerState = ref({
      is_registered:              false,
      is_ready:                   false,
      is_install_prompt_ready:    false,
      is_waiting_for_install_prompt: false,
      is_pwa_installing:          false,
      is_pwa_installed:           false,
    });

    // ── Analytics click batching ───────────────
    let clickCount     = 0;
    let clickDebounce  = null;

    function batchClickAnalytics() {
      clickCount++;
      if (!clickDebounce) {
        clickDebounce = setTimeout(() => {
          sendAnalyticsToServer(EventNames.UI_CLICKS, clickCount);
          clickCount    = 0;
          clickDebounce = null;
        }, 3000);
      }
    }

    // ── Push notifications ─────────────────────
    const pushManager = usePushNotifications(
      sendEventToServer,
      (subscription) => sendVappSubscriptionToServer(subscription)
    );

    // ── Asset preloader ────────────────────────
    const platform = {
      isIOS: trackEvent.isIOS, // platform detection utility
    };
    const { startPreloading, shouldPreload } = useAssetPreloader(platform);

    // ── Computed visibility flags ──────────────

    /** Base conditions shared by all views */
    const baseConditions = computed(() => ({
      isDataLoaded:    pwaInfoLoaded.value,
      isNotStandalone: !isStandaloneMode.value,
      isNotPwaUrl:     !isOnPwaUrl.value,
      isNotFromGame:   !isFromGamePage.value,
    }));

    const shouldShowPreland = computed(() => {
      const b = baseConditions.value;
      return (
        b.isDataLoaded && b.isNotStandalone && b.isNotPwaUrl &&
        b.isNotFromGame && preland.value && prelandEnabled.value
      );
    });

    const shouldShowAndroidLanding = computed(() => {
      const b        = baseConditions.value;
      const hasPreland = preland.value && prelandEnabled.value;
      return (
        (b.isDataLoaded && b.isNotStandalone && b.isNotPwaUrl && !platform.isIOS && !hasPreland) ||
        (isFromGamePage.value && !platform.isIOS)
      );
    });

    const shouldShowIosLanding = computed(() => {
      const b        = baseConditions.value;
      const hasPreland = preland.value && prelandEnabled.value;
      return (
        (b.isDataLoaded && b.isNotStandalone && b.isNotPwaUrl && platform.isIOS && !hasPreland) ||
        (isFromGamePage.value && platform.isIOS)
      );
    });

    const prelandAlias = computed(() => preland.value?.alias ?? null);

    // ── Navigation helpers ─────────────────────

    function _resolveCredentials() {
      return {
        userId:   ENV === "stage" ? STAGE_USER_ID  : getCookie("user_id"),
        hostname: ENV === "stage" ? STAGE_HOSTNAME : window.location.hostname,
      };
    }

    function navigateToUrl(url) {
      window.location.href = url;
    }

    function openUrlInNewTab(url) {
      window.open(url, "_blank");
    }

    function openChromeIntent() {
      const { userId, hostname } = _resolveCredentials();
      window.open(getRedirectUrl(hostname, userId), "_blank");
    }

    function navigateWithChromeIntent() {
      const { userId, hostname } = _resolveCredentials();
      const url = getBrowserIntentUrl(hostname, userId);

      if (!localStorage.getItem(ScrollKeys.INTENT_EVENT_SENT)) {
        sendAnalyticsToServer(EventNames.INTENT, url);
        localStorage.setItem(ScrollKeys.INTENT_EVENT_SENT, "true");
      }

      window.location.href = url;
    }

    function navigateWithFacebookIntent() {
      const { userId, hostname } = _resolveCredentials();
      const url = getFacebookIntentUrl(hostname, userId);

      if (!localStorage.getItem(ScrollKeys.INTENT_EVENT_SENT)) {
        sendAnalyticsToServer(EventNames.INTENT, url);
        localStorage.setItem(ScrollKeys.INTENT_EVENT_SENT, "true");
      }

      window.location.href = url;
    }

    function openPwaOfferPage() {
      const userId = getCookie("user_id");
      if (userId) {
        window.open(`${OPEN_URL}_${userId}?v=${userId}`, "_blank");
      } else {
        window.open(OPEN_URL, "_blank");
      }
    }

    /**
     * Handles the main install/intent click.
     * @param {boolean} fromWindowClick — true when fired from a global click listener
     */
    function handleIntent(fromWindowClick = false) {
      try {
        const isSamsungCapable = checkWebApk(window.navigator.userAgent);
        const { userId }       = _resolveCredentials();
        const isSpecialDomain  = computed(() =>
          window.location.hostname === "allingoodmydd.store"
        ).value;

        if (fromWindowClick) {
          if (isSamsungCapable && isSpecialDomain) {
            browserChooserOpen.value = true;
            return;
          }

          const intentUrl = getBrowserIntentUrl(_resolveCredentials().hostname, userId);
          if (!localStorage.getItem(ScrollKeys.INTENT_EVENT_SENT)) {
            sendAnalyticsToServer(EventNames.INTENT, intentUrl);
            localStorage.setItem(ScrollKeys.INTENT_EVENT_SENT, "true");
          }

          const anchor = document.getElementById("rd");
          if (anchor) {
            anchor.setAttribute("href", intentUrl);
            anchor.click();
          }
          return;
        }

        if (isSamsungCapable && isSpecialDomain) {
          browserChooserOpen.value = true;
          return;
        }

        navigateWithChromeIntent();
      } catch (err) {
        const standardError = standardizeError(
          ErrorCodes.BROWSER_INTENT_ERROR, err,
          { info: "Intent navigation failed" }
        );
        handleStandardizedError(standardError);
      }
    }

    // ── Offer redirect ─────────────────────────

    async function redirectToOffer() {
      if (app.value.offer) {
        navigateToUrl(app.value.offer);
        return;
      }

      const cachedOffer = localStorage.getItem("offer");
      if (cachedOffer) {
        navigateToUrl(cachedOffer);
        return;
      }

      try {
        await fetchAppFromApi();
        if (app.value.offer) navigateToUrl(app.value.offer);
      } catch {
        console.warn("API fetch failed — no offer URL available");
      }
    }

    // ── First-open tracking ────────────────────

    async function trackFirstOpen() {
      if (!localStorage.getItem("firstOpened")) {
        const eventName = isStandaloneMode.value ? "open" : "openbr";
        await sendEventToServer(eventName);
        localStorage.setItem("firstOpened", "true");
      }
    }

    // ── Initialise push + preconnect ───────────

    let pushInitialised = false;

    async function initialisePush() {
      if (pushInitialised) return;
      pushInitialised = true;

      const cachedOffer = localStorage.getItem("offer");
      if (cachedOffer) preconnectLink("preconnect", cachedOffer, "");

      await trackFirstOpen();
      await pushManager.requestPushPermission().then(() => {
        pushPermissionDone.value = true;
      });
    }

    // ── Vapp subscription helper ───────────────

    function sendVappSubscriptionToServer(subscription) {
      const { userId, hostname }  = _resolveCredentials();
      const language  = navigator.language;
      const timeZone  = Intl.DateTimeFormat().resolvedOptions().timeZone;

      postMessageToSW("sendVappSubscription", {
        subscription,
        userId,
        hostname,
        language,
        timeZone,
      });
    }

    // ── FBC/FBP helper ─────────────────────────

    function sendFbcFbpIfNeeded() {
      const { userId, hostname } = _resolveCredentials();
      const fbc = getCookie("_fbc");
      const fbp = getCookie("_fbp");

      if (!fbc || !fbp || localStorage.getItem(ScrollKeys.FBC_FBP_SENT)) return;

      postMessageToSW("sendTestFbcFbp", { hostname, userId, fbc, fbp });
      localStorage.setItem(ScrollKeys.FBC_FBP_SENT, "true");
    }

    // ── High-entropy UA helper ─────────────────

    async function sendUserAgentData() {
      const { userId, hostname } = _resolveCredentials();
      let userAgentData = "";

      if (navigator.userAgentData) {
        const highEntropy = await navigator.userAgentData.getHighEntropyValues([
          "architecture", "model", "bitness", "platformVersion", "fullVersionList",
        ]);
        userAgentData = JSON.stringify(highEntropy);
      }

      postMessageToSW("sendTestUa", { hostname, userId, userAgentData });
    }

    // ── Event sending (with SW fallback) ──────

    async function sendEvent(eventName) {
      if ("serviceWorker" in navigator) {
        const { userId, hostname } = _resolveCredentials();
        await postMessageToSW("sendEvent", { eventName, hostname, userId });
      } else {
        await sendEventToServer(eventName);
      }
    }

    // ── Vapp callback ──────────────────────────

    function sendVCallback() {
      const userId  = getCookie("user_id");
      const pwaUuid = getCookie("pwa_id");
      trackHit(`${CALLBACK_BASE_URL}?pwa_uid=${userId}&pwa_uuid=${pwaUuid}`);
    }

    // ── Related apps check ─────────────────────

    async function isRelatedAppInstalled() {
      if (!navigator.getInstalledRelatedApps) return false;
      try {
        const apps = await navigator.getInstalledRelatedApps();
        return !!apps.find(app => app.url?.includes(window.location.hostname));
      } catch (err) {
        console.error("getInstalledRelatedApps error:", err);
        return false;
      }
    }

    // ── Comment actions ────────────────────────

    function likeComment(index, liked) {
      app.value.comments[index].is_liked = liked;
      if (liked) {
        app.value.comments[index].likes++;
        app.value.comments[index].is_disliked = false;
      } else {
        app.value.comments[index].likes--;
      }
    }

    function dislikeComment(index, disliked) {
      app.value.comments[index].is_disliked = disliked;
      if (disliked && app.value.comments[index].is_liked) {
        app.value.comments[index].likes--;
        app.value.comments[index].is_liked = false;
      }
    }

    // ── Inline JSON data extraction (SSR data islands) ─

    async function fetchAppFromIndex() {
      const el = document.getElementById("pwaInfo");
      if (!el) return;

      const raw = (el.textContent || el.innerText)
        .replace(/var pwaInfo\s*=\s*/, "")
        .replace(/;\s*$/, "")
        .trim();

      try {
        const parsed = JSON.parse(raw);
        applyAppData(parsed);
      } catch (err) {
        console.error("Failed to parse inline pwaInfo JSON:", err);
      }
    }

    async function fetchPrelandFromIndex() {
      if (ENV === "stage") {
        prelandEnabled.value = true;
        preland.value = {
          alias:        PrelandAliases.CHICKEN_ROAD_2,
          final_action: FinalActions.PWA_INSTALL,
          fields:       { key: "value" },
        };
        return;
      }

      let fields = {};
      const el   = document.getElementById("prelandInfo");

      if (el) {
        const raw = (el.textContent || el.innerText)
          .replace(/var prelandInfo\s*=\s*/, "")
          .replace(/;\s*$/, "")
          .trim();

        try {
          fields               = JSON.parse(raw);
          prelandEnabled.value = true;
        } catch {
          prelandEnabled.value = false;
        }
      } else {
        prelandEnabled.value = false;
      }

      if (prelandEnabled.value) {
        const aliasMeta       = document.querySelector('meta[name="preland-alias"]');
        const finalActionMeta = document.querySelector('meta[name="preland-final-action"]');

        const alias       = aliasMeta?.getAttribute("content") || PrelandAliases.CHICKEN_ROAD;
        const rawAction   = finalActionMeta?.getAttribute("content") || "0";
        const finalAction = isNaN(Number(rawAction))
          ? FinalActions.PWA_INSTALL
          : Number(rawAction);

        preland.value = { alias, final_action: finalAction, fields };
      } else {
        preland.value = null;
      }
    }

    // ── Global event bus bindings ──────────────

    provide("openChrome",                 navigateWithChromeIntent);
    provide("navigateWithIntent",         handleIntent);
    provide("sendEvent",                  sendEvent);
    provide("sendFbcFbp",                 sendFbcFbpIfNeeded);
    provide("sendVappSubscriptionToServer", sendVappSubscriptionToServer);
    provide("openStartPWAPage",           openPwaOfferPage);
    provide("isRelatedAppsInstalled",     isRelatedAppInstalled);
    provide("commentLikeActions",         { likeComment, dislikeComment });

    // ── User ID from meta tag ──────────────────

    const metaUserId   = document.querySelector('meta[name="user_id"]')?.getAttribute("content");
    const cookieUserId = getCookie("user_id");
    if (metaUserId && !cookieUserId) {
      setCookie("user_id", metaUserId, 365);
    }

    // ── Watchers ───────────────────────────────

    // Load preland component when alias becomes available
    watch([shouldShowPreland, prelandAlias], ([show, alias]) => {
      if (!show || !alias) return;

      if (PRELAND_REGISTRY[alias]) {
        activePrelandComponent.value = defineAsyncComponent(PRELAND_REGISTRY[alias]);
      } else {
        console.warn(`Preland alias "${alias}" not found — redirecting to store`);
        redirectToGameFallback();
      }
    });

    function redirectToGameFallback() {
      // Trigger game navigation and flag component as hidden after transition
      setTimeout(() => { isFromGamePage.value = true; }, 1000);
    }

    // Scroll-down analytics
    watch(() => isScrollingDown.value, (scrollingDown) => {
      if (scrollingDown && !localStorage.getItem(ScrollKeys.SCROLL_DOWN_EVENT_SENT)) {
        sendAnalyticsToServer(EventNames.SCROLL, true);
        localStorage.setItem(ScrollKeys.SCROLL_DOWN_EVENT_SENT, "true");
      }
    });

    // Progress bar animation end → redirect to offer
    watch(progressBarRef, (el) => {
      if (el) {
        el.addEventListener("animationend", () => redirectToOffer());
      }
    }, { immediate: true });

    // Start asset preloading once all data is ready
    watch(
      [() => preland.value, () => pwaInfoLoaded.value, () => app.value],
      ([prelandData, loaded, appData]) => {
        if (prelandData && shouldPreload(prelandData.final_action) && loaded && appData) {
          startPreloading(appData);
        }
      },
      { immediate: true }
    );

    // Debug watchers (stage only)
    if (ENV === "stage") {
      watch(shouldShowPreland, (n, o) =>
        console.log(`shouldShowPreland: ${o} → ${n}`)
      );
      watch(shouldShowAndroidLanding, (n, o) =>
        console.log(`shouldShowAndroidLanding: ${o} → ${n}`)
      );
    }

    // Visibility change counter (used by progress animation key)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") visibilityCounter.value++;
    });

    // ── Before install prompt ──────────────────

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      beforeInstallPromptEvt.value               = e;
      serviceWorkerState.value.is_install_prompt_ready = true;
    });

    if (window.deferredPrompt) {
      beforeInstallPromptEvt.value               = window.deferredPrompt;
      serviceWorkerState.value.is_install_prompt_ready = true;
    }

    if (window.matchMedia("(display-mode: standalone)").matches) {
      serviceWorkerState.value.is_pwa_installed = true;
      isStandaloneMode.value                    = true;
    }

    // ── Service Worker registration ────────────

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data.type === "SW_ERROR") {
          const { error } = event.data;
          const standardError = standardizeError(
            ErrorCodes.SERVICE_WORKER_ERROR,
            new Error(error.message),
            {
              url:      error.url      || null,
              method:   error.method   || null,
              filename: error.filename || null,
              line:     error.lineno   || null,
              info:     `SW Error Type: ${error.type}`,
            }
          );
          handleStandardizedError(standardError);
        }
      });

      navigator.serviceWorker.register(SW_PATH)
        .then((registration) => {
          serviceWorkerState.value.is_registered = true;

          navigator.serviceWorker.ready.then((readyReg) => {
            serviceWorkerState.value.is_ready = true;

            if ("SyncManager" in window) {
              readyReg.sync?.register(ServiceWorkerKeys.SYNC_TAG).catch(console.warn);
            } else {
              console.warn("Background Sync not supported — using postMessage fallback");
              registration.active?.postMessage({ type: "retryFailedRequests" });
            }
          });

          registration.onupdatefound = () => {
            console.log("New Service Worker update found.");
          };
        })
        .catch(console.error);

      // Reload once on controller change
      let controllerChangeHandled = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!controllerChangeHandled) {
          controllerChangeHandled = true;
          window.location.reload();
        }
      });
    }

    // ── Router guards ──────────────────────────

    router.beforeEach(async (to) => {
      // Extract user_id from /pwa_<id> routes
      const pwaMatch = to.path.match(/^\/pwa_([\w-]+)$/);
      if (pwaMatch && !getCookie("user_id")) {
        setCookie("user_id", pwaMatch[1], 365);
      }

      // Flag pwa URL
      if (to.fullPath.includes(OPEN_URL) && !isStandaloneMode.value) {
        isOnPwaUrl.value = true;
      }

      // Initialise push on pwa URL or standalone
      if (to.fullPath.includes(OPEN_URL) || isStandaloneMode.value) {
        await initialisePush();
      }

      // Restore installed state from localStorage
      if (localStorage.getItem(ScrollKeys.IS_IOS_PWA_INSTALLED)) {
        serviceWorkerState.value.is_pwa_installed = true;
      }
    });

    // ── Lifecycle ─────────────────────────────

    onMounted(async () => {
      // Cleanup old caches via SW
      const swReady = await navigator.serviceWorker?.ready;
      swReady?.active?.postMessage({ action: "cleanupOldCaches" });

      // Vue load-time analytics
      const startTime      = window.vueLoadStartTime || performance.now();
      const loadTimeSeconds = Math.round((performance.now() - startTime) / 1000);
      sendAnalyticsToServer("vue_app_load", loadTimeSeconds);

      trackHit.startTrackerHit();

      // On pwa/standalone — trigger push flow immediately
      if (isOnPwaUrl.value || isStandaloneMode.value) {
        await initialisePush();
      }

      // Check if related app already installed
      if (await isRelatedAppInstalled()) {
        serviceWorkerState.value.is_pwa_installed = true;
      }

      // Setup click handling and intent navigation
      if (!isStandaloneMode.value) {
        if (!pwaInfoLoaded.value) await fetchAppFromApi();

        setTimeout(async () => {
          const webApkInstallable = await checkWebApk?.();
          const needsClickHandler =
            !webApkInstallable &&
            !platform.isSafari &&
            !platform.isIOS &&
            !platform.isChromeIOS;

          if (needsClickHandler) {
            window.addEventListener("click", (e) => {
              batchClickAnalytics();
              handleIntent();
              e.stopPropagation();
              e.stopImmediatePropagation();
            });

            // Unsupported browsers get a direct intent
            const needsDirectIntent =
              !platform.isXiaomiBrowser &&
              !platform.isOpera &&
              !platform.isWhaleBrowser &&
              !platform.isYaBrowser;

            if (needsDirectIntent) handleIntent(true);
          }

          // Facebook / Instagram on iOS
          if (platform.isIOS && (platform.isFacebookBrowser || platform.isInstagramBrowser)) {
            window.addEventListener("click", (e) => {
              batchClickAnalytics();
              navigateWithFacebookIntent();
              e.stopPropagation();
              e.stopImmediatePropagation();
            });
            navigateWithFacebookIntent();
          }
        }, 1000);
      }

      // Delayed FBC/FBP send
      setTimeout(sendFbcFbpIfNeeded, 1000);
    });

    onUnmounted(() => {
      stopRetryInterval();
    });

    // ── Fetch data on create ───────────────────

    fetchPrelandFromIndex();
    fetchAppFromIndex();

    // ── Expose to template ─────────────────────
    return {
      app,
      preland,
      prelandEnabled,
      beforeInstallPromptEvt,
      pwaInfoLoaded,
      serviceWorkerState,
      isStandaloneMode,
      isOnPwaUrl,
      isFromGamePage,
      pushPermissionDone,
      visibilityCounter,
      progressBarRef,
      browserChooserOpen,
      activePrelandComponent,

      shouldShowAndroidLanding,
      shouldShowIosLanding,
      shouldShowPreland,

      MarketPageComponent,
      AppStoreComponent,
      BottomSheetComponent,

      openChromeIntent,
      navigateWithChromeIntent,
      redirectToGameFallback,
      sendAnalyticsToServer,
      sendEvent,
      sendFbcFbpIfNeeded,
      sendVCallback,
      redirectToOffer,

      // Used in template
      SAMSUNG_BROWSER_LOGO,
      CHROME_LOGO,
    };
  },
});

export { usePwaAppData, useAssetPreloader, usePushNotifications, postMessageToSW, stopRetryInterval };
