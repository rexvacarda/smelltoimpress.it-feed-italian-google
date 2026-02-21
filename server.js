import express from "express";

const app = express();

const {
  PORT = 3000,

  // Shopify Storefront API
  SHOPIFY_STORE_DOMAIN,           // e.g. "smelltoimpress.myshopify.com"
  SHOPIFY_STOREFRONT_TOKEN,       // Storefront API access token

  // Italy settings
  IT_BASE_URL,                    // e.g. "https://smelltoimpress.it" or "https://smelltoimpress.co.uk/it"
  IT_GOOGLE_PRODUCT_CATEGORY,     // optional
  BRAND_FALLBACK = "SmellToImpress",

  // Recommended: only export in-stock items
  IT_ONLY_IN_STOCK = "true",

  // Optional: feed title/description
  FEED_TITLE = "SmellToImpress Italy",
  FEED_DESCRIPTION = "Google Merchant Center feed (IT)"
} = process.env;

function must(val, name) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripHtml(html) {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function toGoogleAvailability(availableForSale) {
  return availableForSale ? "in stock" : "out of stock";
}

// Adjust if your Italian store uses a different structure
function buildProductLink(baseUrl, handle, variantId) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/products/${handle}`);
  if (variantId) url.searchParams.set("variant", variantId);
  return url.toString();
}

async function shopifyStorefrontGraphQL(query, variables = {}) {
  must(SHOPIFY_STORE_DOMAIN, "SHOPIFY_STORE_DOMAIN");
  must(SHOPIFY_STOREFRONT_TOKEN, "SHOPIFY_STOREFRONT_TOKEN");

  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify Storefront API error: ${res.status} ${res.statusText} ${text}`);
  }

  const data = await res.json();
  if (data.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function fetchAllProductsAndVariants() {
  const query = `
    query FeedProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            handle
            title
            vendor
            descriptionHtml
            featuredImage { url }
            images(first: 1) { edges { node { url } } }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  availableForSale
                  price { amount currencyCode }
                }
              }
            }
          }
        }
      }
      shop { name }
    }
  `;
  const data = await shopifyStorefrontGraphQL(query, { first: 250 });
  return {
    shopName: data.shop?.name || "Shop",
    products: data.products.edges.map(e => e.node)
  };
}

function pickImageUrl(product) {
  return product.featuredImage?.url || product.images?.edges?.[0]?.node?.url || "";
}

function buildRss({ baseUrl, items }) {
  const now = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>${xmlEscape(FEED_TITLE)}</title>
  <link>${xmlEscape(baseUrl)}</link>
  <description>${xmlEscape(FEED_DESCRIPTION)}</description>
  <language>it</language>
  <pubDate>${xmlEscape(now)}</pubDate>
${items.join("\n")}
</channel>
</rss>
`;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

app.get("/feed/it.xml", async (_, res) => {
  try {
    must(IT_BASE_URL, "IT_BASE_URL");

    const { shopName, products } = await fetchAllProductsAndVariants();
    const onlyInStock = String(IT_ONLY_IN_STOCK).toLowerCase() === "true";
    const baseUrl = IT_BASE_URL;

    const items = [];

    for (const p of products) {
      const imageUrl = pickImageUrl(p);
      const desc = stripHtml(p.descriptionHtml);
      const brand = p.vendor || BRAND_FALLBACK;

      for (const vEdge of p.variants.edges || []) {
        const v = vEdge.node;

        if (onlyInStock && !v.availableForSale) continue;

        const amount = v.price?.amount;
        const currency = v.price?.currencyCode || "EUR";
        if (!amount) continue;

        const link = buildProductLink(baseUrl, p.handle, v.id);

        const title =
          v.title && v.title !== "Default Title"
            ? `${p.title} - ${v.title}`
            : p.title;

        const id = v.sku ? `SKU-${v.sku}` : `VAR-${v.id}`;

        const gcat = IT_GOOGLE_PRODUCT_CATEGORY
          ? `<g:google_product_category>${xmlEscape(IT_GOOGLE_PRODUCT_CATEGORY)}</g:google_product_category>`
          : "";

        const gtin = v.barcode ? `<g:gtin>${xmlEscape(v.barcode)}</g:gtin>` : "";

        // If no barcode and no sku => tell Google identifiers don't exist
        const identifierExists = (v.barcode || v.sku) ? "" : "<g:identifier_exists>false</g:identifier_exists>";

        items.push(`
  <item>
    <g:id>${xmlEscape(id)}</g:id>
    <g:title>${xmlEscape(title)}</g:title>
    <g:description>${xmlEscape(desc || p.title)}</g:description>
    <g:link>${xmlEscape(link)}</g:link>
    <g:image_link>${xmlEscape(imageUrl)}</g:image_link>
    <g:availability>${xmlEscape(toGoogleAvailability(v.availableForSale))}</g:availability>
    <g:price>${xmlEscape(`${amount} ${currency}`)}</g:price>
    <g:brand>${xmlEscape(brand)}</g:brand>
    ${v.sku ? `<g:mpn>${xmlEscape(v.sku)}</g:mpn>` : ""}
    ${gtin}
    ${identifierExists}
    ${gcat}
    <g:condition>new</g:condition>
  </item>`.trim());
      }
    }

    // If FEED_TITLE wasn't set, fall back to shopName
    if (!process.env.FEED_TITLE) process.env.FEED_TITLE = `${shopName} Italy`;

    const xml = buildRss({ baseUrl, items });

    res.setHeader("Content-Type", "application/rss+xml; charset=UTF-8");
    res.setHeader("Cache-Control", "public, max-age=900");
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).json({ error: "Feed generation failed", message: err?.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`GMC IT feed on :${PORT}`));