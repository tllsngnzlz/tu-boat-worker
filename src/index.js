/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

let memoryCache = {
  data: null,
  timestamp: 0
};

const START_URL = "https://www.tu-sport.de/sportprogramm/bootshaus/";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/" || url.pathname === "/api/slots") {
      try {
        const now = Date.now();
        if (memoryCache.data && now - memoryCache.timestamp < 5 * 60 * 1000)
        {
          return withCors(
            new Response(JSON.stringify(memoryCache.data, null, 2), {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "public, max-age=300"
              }
            })
          );
        }

        const data = await collectAllSlots();

        memoryCache = {
          data,
          timestamp: now
        };

        return withCors(
          new Response(JSON.stringify(data, null, 2), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "public, max-age=300"
            }
          })
        );
      } catch (err) {
        return withCors(
          new Response(
            JSON.stringify(
              {
                error: err?.message || String(err),
                stack: err?.stack || null
              },
              null,
              2
            ),
            {
              status: 500,
              headers: { "content-type": "application/json; charset=utf-8" }
            }
          )
        );
      }
    }

    return withCors(new Response("Not found", { status: 404 }));
  }
};

async function collectAllSlots() {
  const bootsverleihUrl = await findBootsverleihUrl();
  const overviewUrl = await findBootOverviewUrl(bootsverleihUrl);
  const categoryPages = await findBoatCategoryPages(overviewUrl);

  const categorySourcesNested = [];
  for (const categoryPage of categoryPages) {
    try {
      const sources = await discoverBookingSourcesForCategory(categoryPage);
      categorySourcesNested.push(sources);
    } catch (err) {
      console.error(`Fehler bei Kategorie "${categoryPage.text}":`, err);
    } 
  }

  const bookingSources = uniqueBy(
    categorySourcesNested.flat(),
    (x) => `${x.category}|${x.bookingUrl}`
  );

  const availabilityPages = [];
  for (const source of bookingSources) {
    try {
      const page  = await fetchAvailabilityPage(source);
      availabilityPages.push(page);
    } catch (err) {
      console.error(`Fehler bei Buchungsquelle "${source.bookingUrl}":`, err);
    } 
  }

  const sources = availabilityPages.map((p) => ({
    category: p.category,
    pattern: p.pattern,
    timeRange: p.timeRange,
    dateRange: p.dateRange,
    dayPattern: p.dayPattern,
    courseUrl: p.courseUrl,
    bookingUrl: p.bookingUrl,
    kursid: p.kursid,
    title: p.title
  }));

  const slots = availabilityPages.flatMap((p) => p.slots);

  return {
    updatedAt: new Date().toISOString(),
    discovery: {
      startUrl: START_URL,
      bootsverleihUrl,
      overviewUrl
    },
    counts: {
      categoryPages: categoryPages.length,
      bookingSources: bookingSources.length,
      slots: slots.length
    },
    sources,
    slots
  };
}

async function findBootsverleihUrl() {
  const html = await fetchText(START_URL);
  const links = extractAnchors(html, START_URL);

  const match =
    findLink(
      links,
      (l) =>
        /bootsverleih/i.test(l.text) ||
        /\/bootshaus\/bootsverleih\/?$/i.test(l.href) 
    ) || null;

  if (!match) {
    throw new Error("Bootsverleih-Link nicht gefunden.");
  }

  return match.href;
}

async function findBootOverviewUrl(bootsverleihUrl) {
  const html = await fetchText(bootsverleihUrl);
  const links = extractAnchors(html, bootsverleihUrl);

  const match =
    findLink(
      links,
      (l) =>
        /bootsübersicht/i.test(l.text)
    ) || null;

  if (!match) {
    throw new Error("Bootsübersicht/-Buchung-Link nicht gefunden.");
  }

  return match.href;
}

async function findBoatCategoryPages(overviewUrl) {
  const html = await fetchText(overviewUrl);
  const links = extractAnchors(html, overviewUrl);

  const categoryLinks = links.filter((l) => {
    return (
      /Segeln - Einzelterminbuchung/i.test(l.text) &&
      /tu-sport\.de/i.test(l.href) &&
      /\/kurse\//i.test(l.href)
    ); 
  });

  return uniqueBy(categoryLinks, (x) => x.href);
}

async function discoverBookingSourcesForCategory(categoryLink) {
  const html = await fetchText(categoryLink.href);
  const links = extractAnchors(html, categoryLink.href);
  const categoryTitle = extractH1(html) || categoryLink.text;

  const bookingLinks = links.filter((l) => {
    return (
      /zeh\.tu-berlin\.de/i.test(l.href) &&
      /anmeldung\.fcgi/i.test(l.href) &&
      /buchen/i.test(l.text)
    );
  });

  return uniqueBy(
    bookingLinks.map((link) => {
      const meta = inferPatternMeta(html, link.href);
      return {
        category: categoryTitle,
        courseUrl: categoryLink.href,
        bookingUrl: link.href,
        pattern: meta.pattern,
        dateRange: meta.dateRange,
        dayPattern: meta.dayPattern,
        timeRange: meta.timeRange
      };
    }),
    (x) => x.bookingUrl
  );
}

async function fetchAvailabilityPage(source) {
  const html = await fetchText(source.bookingUrl);
  const title = extractClassText(html, "anm_big") || source.category;
  const kursid =
    extractInputValue(html, "Kursid") ||
    new URL(source.bookingUrl).searchParams.get("Kursid") ||
    null;

  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const slots = [];

  for (const row of rows) {
    const rowHtml = row[1];

    const displayDateMatch = rowHtml.match(/<b>\s*(\d{2}\.\d{2}\.\d{4})\s*<\/b>/i);
    if (!displayDateMatch) continue;

    const terminMatch = rowHtml.match(
      /<input[^>]*type\s*=\s*["']?radio["']?[^>]*name\s*=\s*["']?Termin["']?[^>]*value\s*=\s*["']([^"']+)["']/i
    );

    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      cleanText(m[1])
    );

    const available = Boolean(terminMatch);
    const termin = terminMatch?.[1] || null;
    const weekday = cells[1] || null;
    const time = cells[3] || null;
    const statusText = cells[0] || null;
    const displayDate = displayDateMatch[1];

    slots.push({
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
      weekday,
      time,
      available,
      statusText
    });
  }

  return {
    ...source,
    title,
    kursid,
    slots
  };
}

function extractColumnValue(rowHtml, columnNumber) {
  const re = new RegExp(
    `<div class="table-cell[^"]*column-${columnNumber}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`,
    "i"
  );

  const match = rowHtml.match(re);
  if (!match) return null;

  let cellHtml = match[1];

  // Labels wie "Details", "Datum", "Tag", "Uhrzeit" entfernen
  cellHtml = cellHtml.replace(/<span class="tablelable">[\s\S]*?<\/span>/gi, "");

  // <br> in Zeilenumbrüche umwandeln
  cellHtml = cellHtml.replace(/<br\s*\/?>/gi, "\n");

  // Restliches HTML entfernen und säubern
  return cleanText(cellHtml).replace(/\s*\n\s*/g, ", ");
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
      timeRange: extractColumnValue(rowHtml, 5)
    };
  }

  return {
    pattern: null,
    dateRange: null,
    dayPattern: null,
    timeRange: null
  };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; TU-Boat-Worker/1.0)"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch fehlgeschlagen: ${url} (${res.status})`);
  }

  return await res.text();
}

function extractAnchors(html, baseUrl) {
  const anchors = [];

  const regex =
    /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const hrefRaw = match[1];
    const textRaw = match[2];

    const hrefDecoded = decodeHtmlEntities(hrefRaw);

    const href = safeResolveUrl(hrefDecoded, baseUrl);

    anchors.push({
      href,
      text: cleanText(textRaw),
      index: match.index
    });
  }

  return anchors;
}

function extractH1(html) {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? cleanText(m[1]) : null;
}

function extractClassText(html, className) {
  const re = new RegExp(
    `<[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i"
  );
  const m = html.match(re);
  return m ? cleanText(m[1]) : null;
}

function extractInputValue(html, name) {
  const re = new RegExp(
    `<input[^>]*name=["']?${escapeRegExp(name)}["']?[^>]*value=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function findLink(links, predicate) {
  return links.find(predicate) || null;
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/?(?:p|div|tr|td|th|li|ul|ol|table|tbody|thead|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi, "\n")
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
    szlig: "ß"
  };

  return str
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
      if (entity[0] === "#") {
        const isHex = entity[1]?.toLowerCase() === "x";
        const num = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isFinite(num) ? String.fromCodePoint(num) : _;
      }
      return named[entity] ?? _;
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
  const out = [];

  for (const item of arr) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}


function lastCapture(text, regex) {
  let last = null;
  for (const m of text.matchAll(regex)) {
    last = m[1]?.replace(/\s+/g, " ").trim() || null;
  }
  return last;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
