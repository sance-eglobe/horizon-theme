/**
 * inventory-location-dropdown.js
 *
 * Fetches per-location inventory via Storefront API.
 * B2B: Shopify automatically scopes storeAvailability to the
 *      company location's catalog when the buyer context is set.
 * B2C: All locations are returned.
 *
 * Edge cases handled:
 *  - inventory tracking disabled  → fallback badge (handled in Liquid)
 *  - all locations out of stock   → shows "Out of stock" for each
 *  - API error                    → graceful error message
 *  - variant change on PDP        → re-fetches for new variant
 */

// @ts-nocheck
const STOREFRONT_API_URL = `${window.Shopify.routes.root}api/2026-01/graphql.json`;
const STOREFRONT_TOKEN = window.shopifyStorefrontToken; // set via theme settings or meta tag

// Cache to avoid duplicate requests for same variant
const _cache = new Map();

/**
 * Build the GraphQL query.
 * storeAvailability is automatically filtered to the B2B buyer's catalog
 * when a buyerIdentity / company location context is active.
 */
function buildQuery(variantId) {
  // Storefront API requires GID format
  const gid = variantId.toString().includes("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;

  return {
    query: `
      query InventoryByLocation($variantId: ID!) {
        node(id: $variantId) {
          ... on ProductVariant {
            id
            title
            availableForSale
            quantityAvailable
            storeAvailability(first: 20) {
              edges {
                node {
                  available
                  quantityAvailable
                  location {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `,
    variables: { variantId: gid },
  };
}

/**
 * Fetch inventory from Storefront API.
 * Returns array of { locationName, available, quantity }
 */
async function fetchInventory(variantId) {
  if (_cache.has(variantId)) return _cache.get(variantId);

  const res = await fetch(STOREFRONT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
    },
    body: JSON.stringify(buildQuery(variantId)),
  });

  if (!res.ok) throw new Error(`Storefront API error: ${res.status}`);

  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors[0].message);

  const variant = data?.node;
  if (!variant) return [];

  const locations = variant.storeAvailability.edges.map(({ node }) => ({
    locationName: node.location.name,
    locationId: node.location.id,
    available: node.available,
    quantity: node.quantityAvailable,
  }));

  _cache.set(variantId, locations);
  return locations;
}

/**
 * Render inventory rows into the dropdown list element.
 */
function renderLocations(listEl, locations) {
  if (!locations.length) {
    listEl.innerHTML = `<li class="inventory-location-list__empty">
      ${window.inventoryStrings?.noLocations || "No locations available."}
    </li>`;
    return;
  }

  listEl.innerHTML = locations
    .map(({ locationName, available, quantity }) => {
      const statusClass = available ? "in-stock" : "out-of-stock";
      const statusLabel = available
        ? quantity != null
          ? `${quantity} in stock`
          : "In stock"
        : "Out of stock";

      return `
        <li class="inventory-location-list__item inventory-location-list__item--${statusClass}">
          <span class="inventory-location-list__name">${locationName}</span>
          <span class="inventory-location-list__status">${statusLabel}</span>
        </li>`;
    })
    .join("");
}

/**
 * Wire up a single dropdown component.
 */
function initDropdown(wrapper) {
  const btn = wrapper.querySelector("[data-inventory-toggle]");
  const panel = wrapper.querySelector(".inventory-location-panel");
  const listEl = wrapper.querySelector("[data-inventory-list]");
  const tracking = wrapper.dataset.tracking === "true";

  if (!btn || !tracking) return; // edge case: tracking disabled, nothing to init

  let loaded = false;

  btn.addEventListener("click", async () => {
    const expanded = btn.getAttribute("aria-expanded") === "true";

    btn.setAttribute("aria-expanded", String(!expanded));
    panel.hidden = expanded;

    // Lazy-load on first open
    if (!expanded && !loaded) {
      loaded = true;
      const variantId = wrapper.dataset.variantId;
      try {
        const locations = await fetchInventory(variantId);
        renderLocations(listEl, locations);
      } catch (err) {
        listEl.innerHTML = `<li class="inventory-location-list__error">
          ${window.inventoryStrings?.error || "Could not load inventory."}
        </li>`;
        console.error("[inventory-dropdown]", err);
      }
    }
  });

  /**
   * Re-fetch when variant changes (PDP variant selector).
   * Listens for Shopify's native variant:changed custom event,
   * also works with Horizon/Trade theme's variant-selects element.
   */
  wrapper
    .closest("[data-product-id]")
    ?.addEventListener("variant:changed", (e) => {
      const newVariantId = e.detail?.variant?.id || e.detail?.variantId;
      if (!newVariantId) return;

      wrapper.dataset.variantId = newVariantId;
      loaded = false; // force re-fetch on next open

      // If panel is open, reload immediately
      if (!panel.hidden) {
        loaded = true;
        listEl.innerHTML = `<li class="inventory-location-list__loading">Loading…</li>`;
        fetchInventory(newVariantId)
          .then((locations) => renderLocations(listEl, locations))
          .catch(() => {
            listEl.innerHTML = `<li class="inventory-location-list__error">Could not load inventory.</li>`;
          });
      }
    });
}

// Init all dropdowns on the page
document.querySelectorAll(".inventory-location-dropdown").forEach(initDropdown);

// Re-init after AJAX section loads (e.g. quick-add, cart drawer)
document.addEventListener("shopify:section:load", () => {
  document
    .querySelectorAll(".inventory-location-dropdown")
    .forEach(initDropdown);
});
