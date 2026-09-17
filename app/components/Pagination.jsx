import { useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "./Icons.jsx";

/**
 * Hook to manage client-side pagination state for any list.
 *
 * @param {Array} items - Full list of items
 * @param {number} defaultPageSize - Default items per page (default: 10)
 * @returns {object} Pagination state and paginated slice of items
 */
export function usePagination(items = [], defaultPageSize = 10) {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const safeItems = Array.isArray(items) ? items : [];
  const totalItems = safeItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const validPage = Math.min(Math.max(1, currentPage), totalPages);

  const startIndex = (validPage - 1) * pageSize;
  const paginatedItems = safeItems.slice(startIndex, startIndex + pageSize);

  return {
    currentPage: validPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    totalItems,
    totalPages,
    paginatedItems,
  };
}

/**
 * Universal Shopify-styled Pagination component.
 *
 * RULE: When totalItems <= 10, returns null (does not display).
 */
export function Pagination({
  currentPage = 1,
  totalItems = 0,
  pageSize = 10,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
  itemLabel = "items",
}) {
  // CRITICAL RULE: If 10 or fewer items, do not render pagination controls
  if (totalItems <= 10) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const validPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (validPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  // Generate page numbers with ellipses
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter((p) => p === 1 || p === totalPages || Math.abs(p - validPage) <= 1)
    .reduce((acc, p, idx, arr) => {
      if (idx > 0 && p - arr[idx - 1] > 1) {
        acc.push(-1 * idx);
      }
      acc.push(p);
      return acc;
    }, []);

  return (
    <div className="rv-pagination-container">
      <div className="rv-pagination-info">
        <span>
          Showing <strong>{totalItems === 0 ? 0 : startIndex + 1}–{endIndex}</strong> of <strong>{totalItems}</strong> {itemLabel}
        </span>
        {onPageSizeChange && (
          <>
            <span style={{ color: "var(--rv-border)" }}>•</span>
            <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span>Per page:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  onPageSizeChange(Number(e.target.value));
                  if (onPageChange) onPageChange(1);
                }}
                className="rv-pagination-select"
              >
                {pageSizeOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      <div className="rv-pagination-controls">
        <button
          type="button"
          onClick={() => onPageChange && onPageChange(Math.max(1, validPage - 1))}
          disabled={validPage <= 1}
          className="rv-btn rv-btn-secondary rv-btn-sm"
          style={{ opacity: validPage <= 1 ? 0.5 : 1, cursor: validPage <= 1 ? "not-allowed" : "pointer" }}
          aria-label="Previous page"
        >
          <ArrowLeftIcon size={13} />
          <span>Previous</span>
        </button>

        {pageNumbers.map((p) => {
          if (p < 0) {
            return (
              <span key={p} style={{ padding: "0 4px", color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                …
              </span>
            );
          }
          const isActive = validPage === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange && onPageChange(p)}
              className={`rv-btn rv-btn-sm ${isActive ? "rv-btn-primary" : "rv-btn-secondary"}`}
              style={{
                minWidth: "30px",
                padding: "3px 8px",
                fontWeight: isActive ? 700 : 500,
              }}
              aria-current={isActive ? "page" : undefined}
            >
              {p}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => onPageChange && onPageChange(Math.min(totalPages, validPage + 1))}
          disabled={validPage >= totalPages}
          className="rv-btn rv-btn-secondary rv-btn-sm"
          style={{ opacity: validPage >= totalPages ? 0.5 : 1, cursor: validPage >= totalPages ? "not-allowed" : "pointer" }}
          aria-label="Next page"
        >
          <span>Next</span>
          <ArrowRightIcon size={13} />
        </button>
      </div>
    </div>
  );
}

export default Pagination;
