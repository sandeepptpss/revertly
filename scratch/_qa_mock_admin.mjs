/**
 * Shared mock Shopify admin used by the route-level import/export QA suite.
 * Mutable so a test can point the stubbed `authenticate.admin` at a given shop.
 */
let currentShop = "qa-impexp-route.myshopify.com";
export function setMockShop(shop) {
  currentShop = shop;
}
export function getMockShop() {
  return currentShop;
}

export const LIVE = {
  themes: [{ id: "gid://shopify/Theme/900", name: "Dawn", role: "MAIN", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" }],
  themeFiles: [
    { filename: "layout/theme.liquid", size: 40, body: { content: "<html>\n{{ content_for_layout }}\n</html>" } },
    { filename: "config/settings_data.json", size: 30, body: { content: '{"current":"Default, with a comma"}' } },
  ],
  collections: [
    {
      id: "gid://shopify/Collection/1", title: "Summer, Sale", handle: "summer-sale",
      descriptionHtml: "<p>Line one\nLine two</p>", templateSuffix: "",
      image: { id: "gid://shopify/Image/1", url: "https://cdn/img1.png", altText: "Alt" },
      sortOrder: "BEST_SELLING",
      ruleSet: { appliedDisjunctively: true, rules: [{ column: "TAG", relation: "EQUALS", condition: "summer" }] },
    },
  ],
  pages: [{ id: "gid://shopify/Page/1", title: "About Us", handle: "about-us", body: "<p>Hello,\nworld</p>", bodySummary: "Hello", templateSuffix: "", isPublished: true }],
  menus: [{ id: "gid://shopify/Menu/1", title: "Main menu", handle: "main-menu", items: [{ id: "i1", title: "Home", url: "/", type: "FRONTPAGE", items: [] }] }],
  blogs: [{
    id: "gid://shopify/Blog/1", title: "News", handle: "news", commentPolicy: "MODERATED", templateSuffix: "",
    articles: { nodes: [{ id: "gid://shopify/Article/1", title: "Hello World", handle: "hello-world", body: "<p>Body</p>", summary: "<p>Sum</p>", tags: ["a"], templateSuffix: "", isPublished: true, publishedAt: "2026-03-01T00:00:00Z", image: null }] },
  }],
  products: [{
    id: "gid://shopify/Product/1", title: "Tee, Basic", status: "ACTIVE", vendor: "Acme", productType: "Shirt",
    tags: ["cotton"], handle: "tee-basic", bodyHtml: "<p>Nice tee</p>", templateSuffix: "", publishedAt: "2026-01-01T00:00:00Z",
    images: { nodes: [] }, metafields: { nodes: [] },
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "S", price: "19.99", compareAtPrice: null, sku: "TEE-S", inventoryQuantity: 4, barcode: "" }] },
  }],
};

export function getMockAdmin() {
  return {
    graphql: async (query, opts = {}) => {
      const j = (data) => ({ json: async () => ({ data }) });
      if (query.includes("getThemes")) return j({ themes: { nodes: LIVE.themes } });
      if (query.includes("ThemeFiles")) return j({ theme: { files: { nodes: LIVE.themeFiles } } });
      if (query.includes("getCollections")) return j({ collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LIVE.collections } });
      if (query.includes("getPages")) return j({ pages: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LIVE.pages } });
      if (query.includes("getMenus")) return j({ menus: { nodes: LIVE.menus } });
      if (query.includes("getBlogsWithArticles")) return j({ blogs: { nodes: LIVE.blogs } });
      if (query.includes("getProductsForBackup")) return j({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LIVE.products } });
      if (query.includes("collectionCreate")) return j({ collectionCreate: { collection: { id: "gid://shopify/Collection/new" }, userErrors: [] } });
      if (query.includes("collectionUpdate")) return j({ collectionUpdate: { collection: { id: opts.variables?.input?.id }, userErrors: [] } });
      if (query.includes("pageCreate")) return j({ pageCreate: { page: { id: "gid://shopify/Page/new" }, userErrors: [] } });
      if (query.includes("pageUpdate")) return j({ pageUpdate: { page: { id: opts.variables?.id }, userErrors: [] } });
      if (query.includes("menuCreate")) return j({ menuCreate: { menu: { id: "gid://shopify/Menu/new" }, userErrors: [] } });
      if (query.includes("menuUpdate")) return j({ menuUpdate: { menu: { id: opts.variables?.id }, userErrors: [] } });
      if (query.includes("articleCreate")) return j({ articleCreate: { article: { id: "gid://shopify/Article/new" }, userErrors: [] } });
      if (query.includes("articleUpdate")) return j({ articleUpdate: { article: { id: opts.variables?.id }, userErrors: [] } });
      return j({});
    },
  };
}
