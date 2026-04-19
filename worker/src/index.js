const START_URL = "https://www.tu-sport.de/sportprogramm/bootshaus/";
const CACHE_TTL_MS = 5 * 60 * 1000;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=300",
};

let memoryCache = {
  data: null,
  timestamp: 0,
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname !== "/" && url.pathname !== "/api/slots") {
      return cors(new Response("Not found", { status: 404 }));
    }

    try {
      const now = Date.now();
      const cached = getCached(now);
      if (cached) {
        return json(cached);
      }

      const data = await collectAllSlots();
      memoryCache = { data, timestamp: now };

      return json(data);
    } catch (error) {
      return json(
        {
          error: error?.message || String(error),
          stack: error?.stack || null,
        },
        500,
        { "cache-control": "no-store" }
      );
    }
  },
};

function getCached(now = Date.now()) {
  if (!memoryCache.data) return null;
  if (now - memoryCache.timestamp >= CACHE_TTL_MS) return null;
  return memoryCache.data;
}

function json(data, status = 200, extraHeaders = {}) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        ...JSON_HEADERS,
        ...extraHeaders,
      },
    })
  );
}

async function collectAllSlots() {
  const bootsverleihUrl = await findBootsverleihUrl();
  const overviewUrl = await findBootOverviewUrl(bootsverleihUrl);
  const categoryPages = await findBoatCategoryPages(overviewUrl);

  const categorySourceResults = await Promise.allSettled(
    categoryPages.map(discoverBookingSourcesForCategory)
  );

  const bookingSources = uniqueBy(
    categorySourceResults.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      console.error(
        `Fehler bei Kategorie "${categoryPages[index]?.text ?? "unbekannt"}":`,
        result.reason
      );
      return [];
    }),
    (x) => `${x.category}|${x.bookingUrl}`
  );

  const availabilityResults = await Promise.allSettled(
    bookingSources.map(fetchAvailabilityPage)
  );

  const availabilityPages = availabilityResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    console.error(
      `Fehler bei Buchungsquelle "${bookingSources[index]?.bookingUrl ?? "unbekannt"}":`,
      result.reason
    );
    return [];
  });

  const sources = availabilityPages.map(
    ({
      category,
      pattern,
      timeRange,
      dateRange,
      dayPattern,
      courseUrl,
      bookingUrl,
      kursid,
      title,
    }) => ({
      category,
      pattern,
      timeRange,
      dateRange,
      dayPattern,
      courseUrl,
      bookingUrl,
      kursid,
      title,
    })
  );

  const slots = availabilityPages.flatMap((page) => page.slots);

  return {
    updatedAt: new Date().toISOString(),
    discovery: {
      startUrl: START_URL,
      bootsverleihUrl,
      overviewUrl,
    },
    counts: {
      categoryPages: categoryPages.length,
      bookingSources: bookingSources.length,
      slots: slots.length,
    },
    sources,
    slots,
  };
}

async function findBootsverleihUrl() {
  const html = await fetchText(START_URL);
  const links = extractAnchors(html, START_URL);

  const match = links.find(
    (l) =>
      /bootsverleih/i.test(l.text) ||
      /\/bootshaus\/bootsverleih\/?$/i.test(l.href || "")
  );

  if (!match?.href) {
    throw new Error("Bootsverleih-Link nicht gefunden.");
  }

  return match.href;
}

async function findBootOverviewUrl(bootsverleihUrl) {
  const html = await fetchText(bootsverleihUrl);
  const links = extractAnchors(html, bootsverleihUrl);

  const match = links.find((l) => /bootsübersicht/i.test(l.text));

  if (!match?.href) {
    throw new Error("Bootsübersicht/-Buchung-Link nicht gefunden.");
  }

  return match.href;
}

async function findBoatCategoryPages(overviewUrl) {
  const html = await fetchText(overviewUrl);
  const links = extractAnchors(html, overviewUrl);

  return uniqueBy(
    links.filter(
      (l) =>
        /Segeln - Einzelterminbuchung/i.test(l.text) &&
        /tu-sport\.de/i.test(l.href || "") &&
        /\/kurse\//i.test(l.href || "")
    ),
    (x) => x.href
  );
}

async function discoverBookingSourcesForCategory(categoryLink) {
  const html = await fetchText(categoryLink.href);
  const links = extractAnchors(html, categoryLink.href);
  const categoryTitle = extractH1(html) || categoryLink.text;

  const bookingLinks = uniqueBy(
    links.filter(
      (l) =>
        /zeh\.tu-berlin\.de/i.test(l.href || "") &&
        /anmeldung\.fcgi/i.test(l.href || "") &&
        /buchen/i.test(l.text)
    ),
    (x) => x.href
  );

  return bookingLinks.map((link) => {
    const meta = inferPatternMeta(html, link.href);

    return {
      category: categoryTitle,
      courseUrl: categoryLink.href,
      bookingUrl: link.href,
      pattern: meta.pattern,
      dateRange: meta.dateRange,
      dayPattern: meta.dayPattern,
      timeRange: meta.timeRange,
    };
  });
}

async function fetchAvailabilityPage(source) {
  const html = await fetchText(source.bookingUrl);

  const title = extractClassText(html, "anm_big") || source.category;
  const kursid =
    extractInputValue(html, "Kursid") ||
    new URL(source.bookingUrl).searchParams.get("Kursid") ||
    null;

  const slots = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(
    ([, rowHtml]) => {
      const displayDate = rowHtml.match(/<b>\s*(\d{2}\.\d{2}\.\d{4})\s*<\/b>/i)?.[1];
      if (!displayDate) return [];

      const termin =
        rowHtml.match(
          /<input[^>]*type\s*=\s*["']?radio["']?[^>]*name\s*=\s*["']?Termin["']?[^>]*value\s*=\s*["']([^"']+)["']/i
        )?.[1] || null;

      const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        ([, cellHtml]) => cleanText(cellHtml)
      );

      return [
        {
          category: source.category,
          pattern: source.pattern,
          dateRange: source.dateRange,
          dayPattern: source.dayPattern,
          timeRange: source.timeRange,
          title,
          courseUrl: source.courseUrl,
          bookingUrl: source.bookingUrl,
          bookingAction: "https://www.zeh.tu-berlin.de/cgi/anmeldung.fcgi",
          kursid,
          termin,
          displayDate,
          weekday: cells[1] || null,
          time: cells[3] || null,
          available: Boolean(termin),
          statusText: cells[0] || null,
        },
      ];
    }
  );

  return {
    ...source,
    title,
    kursid,
    slots,
  };
}

function inferPatternMeta(html, bookingUrl) {
  const parts = html.split(/<div class="table-row\b/i);

  for (const part of parts) {
    const rowHtml = `<div class="table-row ${part}`;
    if (!rowHtml.includes(bookingUrl)) continue;

    return {
      pattern: extractColumnValue(rowHtml, 2),
      dateRange: extractColumnValue(rowHtml, 3),
      dayPattern: extractColumnValue(rowHtml, 4),
      timeRange: extractColumnValue(rowHtml, 5),
    };
  }

  return {
    pattern: null,
    dateRange: null,
    dayPattern: null,
    timeRange: null,
  };
}

function extractColumnValue(rowHtml, columnNumber) {
  const match = rowHtml.match(
    new RegExp(
      `<div class="table-cell[^"]*column-${columnNumber}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`,
      "i"
    )
  );

  if (!match) return null;

  let cellHtml = match[1]
    .replace(/<span class="tablelable">[\s\S]*?<\/span>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");

  return cleanText(cellHtml).replace(/\s*\n\s*/g, ", ");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; TU-Boat-Worker/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch fehlgeschlagen: ${url} (${res.status})`);
  }

  return res.text();
}

function extractAnchors(html, baseUrl) {
  const anchors = [];
  const regex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = safeResolveUrl(decodeHtmlEntities(match[1]), baseUrl);
    if (!href) continue;

    anchors.push({
      href,
      text: cleanText(match[2]),
      index: match.index,
    });
  }

  return anchors;
}

function extractH1(html) {
  return html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ? cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)[1])
    : null;
}

function extractClassText(html, className) {
  const match = html.match(
    new RegExp(
      `<[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      "i"
    )
  );

  return match ? cleanText(match[1]) : null;
}

function extractInputValue(html, name) {
  const match = html.match(
    new RegExp(
      `<input[^>]*name=["']?${escapeRegExp(name)}["']?[^>]*value=["']([^"']+)["']`,
      "i"
    )
  );

  return match ? decodeHtmlEntities(match[1]) : null;
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(
        /<\/?(?:p|div|tr|td|th|li|ul|ol|table|tbody|thead|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi,
        "\n"
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}

function cleanText(htmlFragment) {
  return htmlToText(htmlFragment).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(str) {
  if (!str) return "";

  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    auml: "ä",
    ouml: "ö",
    uuml: "ü",
    Auml: "Ä",
    Ouml: "Ö",
    Uuml: "Ü",
    szlig: "ß",
  };

  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1]?.toLowerCase() === "x";
      const num = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : full;
    }

    return named[entity] ?? full;
  });
}

function safeResolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}