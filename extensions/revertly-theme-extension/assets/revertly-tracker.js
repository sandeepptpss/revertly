/**
 * Revertly Storefront Protection Tracker & Embed Script
 */
(function () {
  'use strict';

  if (window.__revertly_initialized) return;
  window.__revertly_initialized = true;

  const rootEl = document.getElementById('revertly-root');
  const shop = rootEl ? rootEl.getAttribute('data-shop') : null;
  const themeId = rootEl ? rootEl.getAttribute('data-theme-id') : null;


  window.Revertly = {
    version: '1.0.0',
    shop: shop,
    themeId: themeId,
    status: 'active',
    ping: function () {
      return { status: 'ok', time: new Date().toISOString() };
    }
  };

  // Optional trust badge click interaction
  const badge = document.getElementById('revertly-trust-badge');
  if (badge) {
    badge.addEventListener('click', function () {
      badge.style.transform = 'scale(0.96)';
      setTimeout(function () {
        badge.style.transform = '';
      }, 150);
    });
  }

  // Diagnostic log in development
  if (window.location.hostname === 'localhost' || window.location.search.includes('revertly_debug=1')) {
    console.log('[Revertly] Storefront Protection Embed loaded for theme:', themeId, 'on shop:', shop);
  }
})();
