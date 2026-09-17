/**
 * Universal CSV Portability & Recovery Engine for Revertly
 * Provides RFC-4180 compliant CSV serialization, deserialization, type detection,
 * and schema normalization for Collections, Pages & Menus, Blogs & Articles, and Products.
 */

// Excel UTF-8 BOM for spreadsheet encoding compatibility
export const UTF8_BOM = "\uFEFF";

/**
 * Escapes a single string/number value according to RFC-4180 rules:
 * - Wrap in double quotes if it contains commas, double quotes, carriage returns, or newlines.
 * - Escape internal double quotes with double quotes ("").
 */
export function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * RFC-4180 compliant parser that correctly processes:
 * - Multiline text enclosed in quotes
 * - Escaped double quotes ("")
 * - CRLF (\r\n) and LF (\n) line breaks
 * - Removes UTF-8 BOM
 */
export function parseCsvRows(csvString) {
  if (!csvString || typeof csvString !== "string") return [];
  const cleanStr = csvString.startsWith(UTF8_BOM) ? csvString.slice(1) : csvString;

  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < cleanStr.length; i++) {
    const char = cleanStr[i];
    const nextChar = cleanStr[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote
          currentField += '"';
          i++; // skip escaped quote
        } else {
          // Closing quote
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\r") {
        if (nextChar === "\n") {
          i++; // skip \n in CRLF
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else if (char === "\n") {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  // Filter out any trailing empty rows
  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
}

/**
 * Converts CSV string into array of row objects keyed by trimmed headers.
 */
export function parseCsvToObjects(csvString) {
  const rows = parseCsvRows(csvString);
  if (rows.length === 0) {
    return { headers: [], data: [] };
  }

  const headers = rows[0].map((h) => h.trim());
  const data = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      obj[header] = row[j] !== undefined ? row[j] : "";
    }
    data.push(obj);
  }

  return { headers, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. COLLECTIONS CSV (Smart & Manual)
// ─────────────────────────────────────────────────────────────────────────────

export function generateCollectionsCsv(collections = []) {
  const headers = [
    "Collection ID",
    "Title",
    "Handle",
    "Type",
    "Sort Order",
    "Template Suffix",
    "Image URL",
    "Image Alt Text",
    "Condition Match",
    "Rules",
    "Description HTML",
  ];

  const rows = (collections || []).map((col) => {
    const isSmart = Boolean(col.ruleSet && Array.isArray(col.ruleSet.rules) && col.ruleSet.rules.length > 0);
    const rulesStr = isSmart ? JSON.stringify(col.ruleSet.rules) : "";
    const conditionMatch = isSmart ? (col.ruleSet.appliedDisjunctively ? "ANY" : "ALL") : "";
    const imageUrl = col.image?.url || col.image?.src || "";
    const imageAlt = col.image?.altText || "";

    return [
      col.id || "",
      col.title || "",
      col.handle || "",
      isSmart ? "SMART" : "MANUAL",
      col.sortOrder || "BEST_SELLING",
      col.templateSuffix || "",
      imageUrl,
      imageAlt,
      conditionMatch,
      rulesStr,
      col.descriptionHtml || col.description || "",
    ].map(escapeCsvField);
  });

  return UTF8_BOM + [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
}

export function parseCollectionsCsv(csvString) {
  const { data } = parseCsvToObjects(csvString);
  if (data.length === 0) {
    throw new Error("Collections CSV contains no data rows.");
  }

  const collections = data
    .map((row) => {
      const title = row["Title"] || row["title"] || "";
      if (!title.trim()) return null;

      const handle = row["Handle"] || row["handle"] || "";
      const id = row["Collection ID"] || row["id"] || undefined;
      const sortOrder = row["Sort Order"] || row["sortOrder"] || "BEST_SELLING";
      const templateSuffix = row["Template Suffix"] || row["templateSuffix"] || "";
      const descriptionHtml = row["Description HTML"] || row["Description"] || row["descriptionHtml"] || "";

      const imageUrl = row["Image URL"] || row["imageUrl"] || "";
      const imageAlt = row["Image Alt Text"] || row["imageAltText"] || "";
      const image = imageUrl ? { url: imageUrl, altText: imageAlt } : null;

      const rulesRaw = row["Rules"] || row["rules"] || "";
      const conditionMatch = (row["Condition Match"] || row["conditionMatch"] || "ALL").toUpperCase();
      const type = (row["Type"] || row["type"] || "").toUpperCase();

      let ruleSet = null;
      if (rulesRaw.trim()) {
        try {
          const parsedRules = JSON.parse(rulesRaw);
          if (Array.isArray(parsedRules) && parsedRules.length > 0) {
            ruleSet = {
              appliedDisjunctively: conditionMatch === "ANY" || conditionMatch === "TRUE",
              rules: parsedRules.map((r) => ({
                column: r.column || "TAG",
                relation: r.relation || "EQUALS",
                condition: r.condition || "",
              })),
            };
          }
        } catch {
          // If non-JSON text rule string like "TAG EQUALS summer"
          const ruleParts = rulesRaw.split(";").map((p) => p.trim()).filter(Boolean);
          if (ruleParts.length > 0) {
            ruleSet = {
              appliedDisjunctively: conditionMatch === "ANY",
              rules: ruleParts.map((rp) => {
                const tokens = rp.split(/\s+/);
                return {
                  column: tokens[0] || "TAG",
                  relation: tokens[1] || "EQUALS",
                  condition: tokens.slice(2).join(" ") || "",
                };
              }),
            };
          }
        }
      } else if (type === "SMART") {
        ruleSet = {
          appliedDisjunctively: conditionMatch === "ANY",
          rules: [],
        };
      }

      return {
        id,
        title,
        handle,
        sortOrder,
        templateSuffix,
        descriptionHtml,
        image,
        ruleSet,
      };
    })
    .filter(Boolean);

  if (collections.length === 0) {
    throw new Error("No valid collections with titles could be parsed from this CSV.");
  }

  return collections;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PAGES & NAVIGATION MENUS CSV
// ─────────────────────────────────────────────────────────────────────────────

export function generatePagesAndMenusCsv(pages = [], menus = []) {
  const headers = [
    "Record Type",
    "ID",
    "Title",
    "Handle",
    "Is Published",
    "Template Suffix",
    "Body HTML",
    "Menu Items",
  ];

  const rows = [];

  // 1. Pages Rows
  for (const page of pages || []) {
    rows.push(
      [
        "PAGE",
        page.id || "",
        page.title || "",
        page.handle || "",
        page.isPublished !== false ? "TRUE" : "FALSE",
        page.templateSuffix || "",
        page.body || page.bodyHtml || "",
        "",
      ].map(escapeCsvField)
    );
  }

  // 2. Menu Rows
  for (const menu of menus || []) {
    const itemsJson = Array.isArray(menu.items) && menu.items.length > 0 ? JSON.stringify(menu.items) : "[]";
    rows.push(
      [
        "MENU",
        menu.id || "",
        menu.title || "",
        menu.handle || "",
        "",
        "",
        "",
        itemsJson,
      ].map(escapeCsvField)
    );
  }

  return UTF8_BOM + [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
}

export function parsePagesAndMenusCsv(csvString) {
  const { data } = parseCsvToObjects(csvString);
  if (data.length === 0) {
    throw new Error("Pages & Menus CSV contains no data rows.");
  }

  const pages = [];
  const menus = [];

  for (const row of data) {
    const recType = (row["Record Type"] || row["recordType"] || "").toUpperCase();
    const title = row["Title"] || row["title"] || "";
    if (!title.trim()) continue;

    const handle = row["Handle"] || row["handle"] || "";
    const id = row["ID"] || row["id"] || undefined;

    if (recType === "MENU" || (row["Menu Items"] && row["Menu Items"].trim() && !row["Body HTML"])) {
      let items = [];
      const rawItems = row["Menu Items"] || row["menuItems"] || "";
      if (rawItems.trim()) {
        try {
          items = JSON.parse(rawItems);
          if (!Array.isArray(items)) items = [];
        } catch {
          items = [];
        }
      }
      menus.push({ id, title, handle, items });
    } else {
      // Treat as Page
      const body = row["Body HTML"] || row["Body"] || row["Body (HTML)"] || row["body"] || "";
      const templateSuffix = row["Template Suffix"] || row["templateSuffix"] || "";
      const isPublishedRaw = (row["Is Published"] || row["isPublished"] || "TRUE").toUpperCase();
      const isPublished = isPublishedRaw !== "FALSE";

      pages.push({
        id,
        title,
        handle,
        body,
        bodyHtml: body,
        templateSuffix,
        isPublished,
      });
    }
  }

  if (pages.length === 0 && menus.length === 0) {
    throw new Error("No valid pages or navigation menus could be parsed from this CSV.");
  }

  return { pages, menus };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. BLOGS & ARTICLES CSV
// ─────────────────────────────────────────────────────────────────────────────

export function generateBlogsAndArticlesCsv(blogs = [], articles = []) {
  const headers = [
    "Record Type",
    "ID",
    "Blog Title",
    "Blog Handle",
    "Title",
    "Handle",
    "Author",
    "Tags",
    "Is Published",
    "Published At",
    "Template Suffix",
    "Image URL",
    "Image Alt Text",
    "Summary HTML",
    "Body HTML",
    "Comment Policy",
  ];

  const rows = [];

  // 1. Articles Rows
  for (const art of articles || []) {
    const tagsStr = Array.isArray(art.tags) ? art.tags.join(", ") : art.tags || "";
    const authorStr = typeof art.author === "object" ? art.author?.name || "" : art.author || "";
    const imageUrl = art.image?.url || art.image?.src || "";
    const imageAlt = art.image?.altText || "";

    rows.push(
      [
        "ARTICLE",
        art.id || "",
        art.blogTitle || "",
        art.blogHandle || "",
        art.title || "",
        art.handle || "",
        authorStr,
        tagsStr,
        art.isPublished !== false ? "TRUE" : "FALSE",
        art.publishedAt || "",
        art.templateSuffix || "",
        imageUrl,
        imageAlt,
        art.summary || art.summaryHtml || "",
        art.body || art.bodyHtml || "",
        "",
      ].map(escapeCsvField)
    );
  }

  // 2. Explicit Blog Rows (if any exist)
  for (const blog of blogs || []) {
    rows.push(
      [
        "BLOG",
        blog.id || "",
        blog.title || "",
        blog.handle || "",
        blog.title || "",
        blog.handle || "",
        "",
        "",
        "",
        "",
        blog.templateSuffix || "",
        "",
        "",
        "",
        "",
        blog.commentPolicy || "MODERATED",
      ].map(escapeCsvField)
    );
  }

  return UTF8_BOM + [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
}

export function parseBlogsAndArticlesCsv(csvString) {
  const { data } = parseCsvToObjects(csvString);
  if (data.length === 0) {
    throw new Error("Blogs & Articles CSV contains no data rows.");
  }

  const articles = [];
  const blogsMap = new Map();

  for (const row of data) {
    const recType = (row["Record Type"] || row["recordType"] || "").toUpperCase();
    const title = row["Title"] || row["title"] || "";
    if (!title.trim()) continue;

    const id = row["ID"] || row["id"] || undefined;
    const handle = row["Handle"] || row["handle"] || "";
    const templateSuffix = row["Template Suffix"] || row["templateSuffix"] || "";

    if (recType === "BLOG") {
      blogsMap.set(handle || title, {
        id,
        title,
        handle,
        templateSuffix,
        commentPolicy: row["Comment Policy"] || row["commentPolicy"] || "MODERATED",
      });
    } else {
      // Treat as Article
      const blogTitle = row["Blog Title"] || row["blogTitle"] || "News";
      const blogHandle = row["Blog Handle"] || row["blogHandle"] || "news";
      const author = row["Author"] || row["author"] || "";
      const tagsRaw = row["Tags"] || row["tags"] || "";
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const isPublished = (row["Is Published"] || row["isPublished"] || "TRUE").toUpperCase() !== "FALSE";
      const publishedAt = row["Published At"] || row["publishedAt"] || "";
      const summary = row["Summary HTML"] || row["summaryHtml"] || row["Summary"] || "";
      const body = row["Body HTML"] || row["bodyHtml"] || row["Body"] || "";
      const imageUrl = row["Image URL"] || row["imageUrl"] || "";
      const imageAlt = row["Image Alt Text"] || row["imageAltText"] || "";
      const image = imageUrl ? { url: imageUrl, altText: imageAlt } : null;

      articles.push({
        id,
        blogTitle,
        blogHandle,
        title,
        handle,
        author,
        tags,
        isPublished,
        publishedAt,
        templateSuffix,
        summary,
        summaryHtml: summary,
        body,
        bodyHtml: body,
        image,
      });

      // Ensure blog exists in map
      if (!blogsMap.has(blogHandle)) {
        blogsMap.set(blogHandle, {
          title: blogTitle,
          handle: blogHandle,
          commentPolicy: "MODERATED",
          templateSuffix: "",
        });
      }
    }
  }

  const blogs = Array.from(blogsMap.values());

  if (articles.length === 0 && blogs.length === 0) {
    throw new Error("No valid articles or blogs could be parsed from this CSV.");
  }

  return { blogs, articles };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PRODUCTS CSV (Generation & Parsing)
// ─────────────────────────────────────────────────────────────────────────────

export function generateProductsCsv(products = []) {
  const headers = [
    "Product ID",
    "Title",
    "Handle",
    "Status",
    "Vendor",
    "Product Type",
    "Tags",
    "Variants Count",
    "Price Min",
    "Price Max",
    "Updated At",
  ];

  const rows = (products || []).map((p) => {
    const raw = p.snapshotData || p;
    const variants = raw.variants || [];
    const prices = variants.map((v) => parseFloat(v.price) || 0);
    const minPrice = prices.length > 0 ? Math.min(...prices).toFixed(2) : "0.00";
    const maxPrice = prices.length > 0 ? Math.max(...prices).toFixed(2) : "0.00";

    return [
      p.productId || raw.id || "",
      raw.title || p.title || "",
      raw.handle || "",
      raw.status || "ACTIVE",
      raw.vendor || "",
      raw.productType || "",
      Array.isArray(raw.tags) ? raw.tags.join(", ") : raw.tags || "",
      variants.length,
      minPrice,
      maxPrice,
      raw.updatedAt || "",
    ].map(escapeCsvField);
  });

  return (
    UTF8_BOM +
    [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\r\n")
  );
}

export function parseProductsCsv(csvString) {
  const { data } = parseCsvToObjects(csvString);
  if (data.length === 0) {
    throw new Error("Products CSV contains no data rows.");
  }

  const products = data
    .map((row) => {
      const title = row["Title"] || row["title"] || "";
      if (!title.trim()) return null;

      const id = row["Product ID"] || row["id"] || undefined;
      const handle = row["Handle"] || row["handle"] || "";
      const status = (row["Status"] || row["status"] || "ACTIVE").toUpperCase();
      const vendor = row["Vendor"] || row["vendor"] || "";
      const productType = row["Product Type"] || row["productType"] || "";
      const tagsRaw = row["Tags"] || row["tags"] || "";
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const minPrice = row["Price Min"] || "0.00";
      const maxPrice = row["Price Max"] || minPrice;

      const variants = [
        {
          price: minPrice,
          title: "Default Title",
        },
      ];
      if (maxPrice !== minPrice) {
        variants.push({
          price: maxPrice,
          title: "Variant Max",
        });
      }

      return {
        id,
        productId: id,
        title,
        handle,
        status,
        vendor,
        productType,
        tags,
        variants,
        bodyHtml: row["Body (HTML)"] || row["Body HTML"] || row["bodyHtml"] || "",
      };
    })
    .filter(Boolean);

  if (products.length === 0) {
    throw new Error("No valid products could be parsed from this CSV.");
  }

  return products;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UNIVERSAL CSV DETECTOR & PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inspects CSV headers and contents to automatically detect dataset format,
 * parses items, and generates standard summary statistics.
 */
export function detectAndParseCsvArchive(csvString) {
  if (!csvString || typeof csvString !== "string" || !csvString.trim()) {
    throw new Error("The CSV file is empty. Please select a valid backup CSV file.");
  }

  const { headers, data } = parseCsvToObjects(csvString);
  if (headers.length === 0 || data.length === 0) {
    throw new Error("The CSV file contains no recognizable data rows to import.");
  }

  const normalizedHeaders = headers.map((h) => h.toLowerCase().trim());

  // 1. Collections Detection
  const hasCollectionId = normalizedHeaders.includes("collection id");
  const hasRules = normalizedHeaders.includes("rules") || normalizedHeaders.includes("condition match");
  const hasSortOrder = normalizedHeaders.includes("sort order");
  if (hasCollectionId || hasRules || (hasSortOrder && normalizedHeaders.includes("title"))) {
    const collections = parseCollectionsCsv(csvString);
    return {
      type: "COLLECTIONS",
      data: { collections },
      summary: {
        products: 0,
        themes: 0,
        collections: collections.length,
        pages: 0,
        menus: 0,
        articles: 0,
      },
    };
  }

  // 2. Blogs & Articles Detection
  const hasBlogTitle = normalizedHeaders.includes("blog title") || normalizedHeaders.includes("blog handle");
  const hasSummaryHtml = normalizedHeaders.includes("summary html");
  const hasCommentPolicy = normalizedHeaders.includes("comment policy");
  if (hasBlogTitle || hasSummaryHtml || hasCommentPolicy) {
    const { blogs, articles } = parseBlogsAndArticlesCsv(csvString);
    return {
      type: "BLOGS",
      data: { blogsAndArticles: { blogs, articles }, blogs, articles },
      summary: {
        products: 0,
        themes: 0,
        collections: 0,
        pages: 0,
        menus: 0,
        articles: articles.length,
      },
    };
  }

  // 3. Pages & Menus Detection
  const hasMenuItems = normalizedHeaders.includes("menu items");
  const hasRecordType = normalizedHeaders.includes("record type");
  const hasBodyHtml = normalizedHeaders.includes("body html") || normalizedHeaders.includes("body (html)");
  if (hasMenuItems || (hasRecordType && (hasBodyHtml || normalizedHeaders.includes("handle")))) {
    const { pages, menus } = parsePagesAndMenusCsv(csvString);
    return {
      type: "PAGES",
      data: { pages, menus },
      summary: {
        products: 0,
        themes: 0,
        collections: 0,
        pages: pages.length,
        menus: menus.length,
        articles: 0,
      },
    };
  }

  // 4. Products Detection
  const hasProductId = normalizedHeaders.includes("product id");
  const hasVariantsCount = normalizedHeaders.includes("variants count");
  const hasPriceMin = normalizedHeaders.includes("price min");
  const hasVendor = normalizedHeaders.includes("vendor");
  if (hasProductId || hasVariantsCount || hasPriceMin || (hasVendor && normalizedHeaders.includes("title"))) {
    const products = parseProductsCsv(csvString);
    return {
      type: "PRODUCTS",
      data: { products },
      summary: {
        products: products.length,
        themes: 0,
        collections: 0,
        pages: 0,
        menus: 0,
        articles: 0,
      },
    };
  }

  // 5. Fallback check for single page/menu exports or generic Shopify exports
  if (normalizedHeaders.includes("title") && (normalizedHeaders.includes("handle") || normalizedHeaders.includes("body"))) {
    const { pages, menus } = parsePagesAndMenusCsv(csvString);
    return {
      type: "PAGES",
      data: { pages, menus },
      summary: {
        products: 0,
        themes: 0,
        collections: 0,
        pages: pages.length,
        menus: menus.length,
        articles: 0,
      },
    };
  }

  throw new Error(
    "Unrecognized CSV format: The file headers do not match any supported data type (Collections, Pages & Menus, Blogs & Articles, or Products). Please ensure your CSV was exported from Revertly."
  );
}
