import "dotenv/config";
import express from "express";
import { create } from "xmlbuilder2";

const app = express();

const {
  PORT = 3000,

  // Shopify (same style as your Zbozi/Glami guide)
  SHOP_MYSHOPIFY_DOMAIN,     // e.g. "smelltoimpress.myshopify.com"
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,

  // Public Italy shop URL for product links
  IT_PUBLIC_DOMAIN,          // e.g. "https://smelltoimpress.it" OR "https://smelltoimpress.co.uk/it"

  // Feed controls
  FEED_CACHE_SECONDS = "900",
  ONLY_IN_STOCK = "true",

  // Optional defaults
  BRAND_FALLBACK = "SmellToImpress",
  GOOGLE_PRODUCT_CATEGORY = "Health & Beauty > Personal Care > Cosmetics > Perfume & Cologne"
} = process.env;

function must(v, name) {
  if (!v) throw new Error(`Missing env var: ${name}`);
}

function boolEnv(v, fallback = false) {
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildProductLink(baseUrl, handle, variantIdNumeric) {
  const clean = baseUrl.replace(/\/$/, "");
  const url = new URL(`${clean}/products/${handle}`);
  if (variantIdNumeric) url.searchParams.set("variant", String(variantIdNumeric));
  return url.toString();
}

// ----------------------
// Admin token (24h) cache
// ----------------------
let tokenCache = { token: null, expiresAtMs: 0 };

async function getAdminToken() {
  must(SHOP_MYSHOPIFY_DOMAIN, "SHOP_MYSHOPIFY_DOMAIN");
  must(SHOPIFY_CLIENT_ID, "SHOPIFY_CLIENT_ID");
  must(SHOPIFY_CLIENT_SECRET, "SHOPIFY_CLIENT_SECRET");

  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAtMs) return tokenCache.token;

  const url = `https://${SHOP_MYSHOPIFY_DOMAIN}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token returned from Shopify");

  // Tokens are ~24h; refresh earlier (23h)
  tokenCache = {
    token: data.access_token,
    expiresAtMs: now + 23 * 60 * 60 * 1000
  };

  return tokenCache.token;
}

async function adminGraphQL(query, variables = {}) {
  const token = await getAdminToken();

  const res = await fetch(`https://${SHOP_MYSHOPIFY_DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Admin GraphQL HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  if (json.errors?.length) throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
  return json.data;
}

// ----------------------
// Feed cache
// ----------------------
let feedCache = { xml: null, expiresAtMs: 0 };

function availabilityFromQty(qty) {
  return qty > 0 ? "in stock" : "out of stock";
}

function safeText(s) {
  // xmlbuilder2 escapes automatically, but keep strings clean
  return String(s ?? "").replace(/\u00A0/g, " ");
}

async function fetchAllProductsPaginated() {
  // Pull enough for most stores; includes pagination for safety.
  const query = `
    query Products($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            legacyResourceId
            handle
            title
            vendor
            descriptionHtml
            featuredImage { url }
            images(first: 1) { edges { node { url } } }

            translations(locale: "it") {
              key
              value
            }

            variants(first: 100) {
              edges {
                node {
                  id
                  legacyResourceId
                  title
                  sku
                  barcode
                  inventoryQuantity

                  contextualPricing(context: {country: IT}) {
                    price { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let after = null;
  const all = [];

  while (true) {
    const data = await adminGraphQL(query, { first: 100, after });
    const conn = data.products;
    for (const e of conn.edges) all.push(e.node);

    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return all;
}

function getTranslation(translations, key) {
  const t = (translations || []).find(x => x.key === key);
  return t?.value || null;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

app.get("/feed-it.xml", async (_, res) => {
  try {
    must(IT_PUBLIC_DOMAIN, "IT_PUBLIC_DOMAIN");

    const now = Date.now();
    const ttlMs = Number(FEED_CACHE_SECONDS) * 1000;
    if (feedCache.xml && now < feedCache.expiresAtMs) {
      res.setHeader("Content-Type", "application/rss+xml; charset=UTF-8");
      res.setHeader("Cache-Control", `public, max-age=${Math.max(60, Number(FEED_CACHE_SECONDS))}`);
      return res.status(200).send(feedCache.xml);
    }

    const onlyInStock = boolEnv(ONLY_IN_STOCK, true);
    const products = await fetchAllProductsPaginated();

    const doc = create({ version: "1.0", encoding: "UTF-8" })
      .ele("rss", { version: "2.0", "xmlns:g": "http://base.google.com/ns/1.0" })
      .ele("channel");

    doc.ele("title").txt("SmellToImpress Italy").up();
    doc.ele("link").txt(IT_PUBLIC_DOMAIN).up();
    doc.ele("description").txt("Google Merchant Center feed (IT)").up();
    doc.ele("language").txt("it").up();

    for (const p of products) {
      const img =
        p.featuredImage?.url ||
        p.images?.edges?.[0]?.node?.url ||
        "";

      // Prefer Italian translations when present
      const titleIT = getTranslation(p.translations, "title") || p.title;
      const bodyIT = getTranslation(p.translations, "body_html") || p.descriptionHtml;

      const description = stripHtml(bodyIT) || stripHtml(p.descriptionHtml) || titleIT;

      const brand = p.vendor || BRAND_FALLBACK;

      for (const ve of (p.variants?.edges || [])) {
        const v = ve.node;

        const qty = Number(v.inventoryQuantity ?? 0);
        if (onlyInStock && qty <= 0) continue;

        const priceObj = v.contextualPricing?.price;
        if (!priceObj?.amount) continue;

        const currency = priceObj.currencyCode || "EUR";
        const amount = priceObj.amount;

        // Google id: prefer SKU, else numeric legacyResourceId
        const gid = v.sku ? `SKU-${v.sku}` : `VAR-${v.legacyResourceId || v.id}`;

        const variantTitle =
          v.title && v.title !== "Default Title"
            ? `${titleIT} - ${v.title}`
            : titleIT;

        const link = buildProductLink(IT_PUBLIC_DOMAIN, p.handle, v.legacyResourceId);

        const item = doc.ele("item");
        item.ele("g:id").txt(safeText(gid)).up();
        item.ele("g:title").txt(safeText(variantTitle)).up();
        item.ele("g:description").txt(safeText(description)).up();
        item.ele("g:link").txt(safeText(link)).up();
        item.ele("g:image_link").txt(safeText(img)).up();
        item.ele("g:availability").txt(availabilityFromQty(qty)).up();
        item.ele("g:price").txt(`${amount} ${currency}`).up();
        item.ele("g:condition").txt("new").up();
        item.ele("g:brand").txt(safeText(brand)).up();
        item.ele("g:google_product_category").txt(safeText(GOOGLE_PRODUCT_CATEGORY)).up();

        // Identifiers
        if (v.barcode) item.ele("g:gtin").txt(safeText(v.barcode)).up();
        if (v.sku) item.ele("g:mpn").txt(safeText(v.sku)).up();

        if (!v.barcode && !v.sku) item.ele("g:identifier_exists").txt("false").up();

        item.up();
      }
    }

    const xml = doc.end({ prettyPrint: true });

    feedCache = { xml, expiresAtMs: Date.now() + ttlMs };

    res.setHeader("Content-Type", "application/rss+xml; charset=UTF-8");
    res.setHeader("Cache-Control", `public, max-age=${Math.max(60, Number(FEED_CACHE_SECONDS))}`);
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).json({ error: "IT feed failed", message: err?.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`GMC IT feed running on :${PORT}`));