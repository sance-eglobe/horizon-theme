//@ts-nocheck

(function B2BCartAddressSelector() {
  const API_VERSION = "2026-01";

  const { shopDomain, storefrontToken, locations, currentLocationId } =
    window.__b2b;
  let cartId = null;

  const select = document.getElementById("b2b-location-select");
  if (!select || !window.__b2b) return;

  // Lazy getters — resolved at call time so DOM is always ready
  const addressDisplay = () => document.getElementById("b2b-address-display");
  const statusEl = () => document.getElementById("b2b-status");
  const methodsPanel = () => document.getElementById("b2b-shipping-methods");
  const methodsList = () => document.getElementById("b2b-methods-list");
  const methodsNone = () => document.getElementById("b2b-methods-none");

  let hasSetAddressBefore = false;
  let selectedDeliveryHandles = {};
  let activeMode = "ship"; // "ship" | "pickup"

  // Hardcoded mapping of Shopify Location GID → delivery option handle
  // for pickup-as-shipping-rate stores.
  // Built from two queries run once: locations query + deliveryGroups query.
  // Read from window.__b2b.pickupHandleMap if available (set via shop metafield),
  // otherwise falls back to building from deliveryGroups at runtime.
  // Structure: Map<locationGid, { handle, title, groupId }>
  let pickupOptionsCache = new Map();

  // Static location→handle map built from your store's data.
  // Key: full location GID, Value: delivery option handle
  // Update this if your pickup rates or locations change.
  const PICKUP_HANDLE_MAP = window.__b2b.pickupHandleMap || {
    "gid://shopify/Location/110547829049": {
      handle: "2337a33d0df96c22202dc2f2832e33c2",
      title: "Pickup [9501409]",
    },
    "gid://shopify/Location/112470622521": {
      handle: "3f010fb190d9d69fc7d06f66556221e7",
      title: "Pickup [9501413]",
    },
    "gid://shopify/Location/112470655289": {
      handle: "4031d6c9d6ee697670f4acf95dccd512",
      title: "Pickup [9501414]",
    },
  };

  /* ─────────────────────────────────────────────────────────────────────────
     STOREFRONT API FETCH
  ───────────────────────────────────────────────────────────────────────── */
  async function storefrontFetch(query, variables = {}) {
    const res = await fetch(
      `https://${shopDomain}/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": storefrontToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    const json = await res.json();
    if (json.errors)
      throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SWITCH SHOPIFY SESSION LOCATION
  ───────────────────────────────────────────────────────────────────────── */
  async function switchShopifyLocation(loc) {
    const url = new URL(loc.urlToSet, window.location.origin);
    url.searchParams.set("return_to", window.location.pathname);
    await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      credentials: "include",
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MUTATIONS — DELIVERY ADDRESS
  ───────────────────────────────────────────────────────────────────────── */
  const DELIVERY_ADDRESSES_ADD = `
    mutation CartDeliveryAddressesAdd($cartId: ID!, $addresses: [CartSelectableAddressInput!]!) {
      cartDeliveryAddressesAdd(cartId: $cartId, addresses: $addresses) {
        cart { id delivery { addresses { id selected } } }
        userErrors { field message code }
      }
    }
  `;

  const DELIVERY_ADDRESSES_REPLACE = `
    mutation CartDeliveryAddressesReplace($cartId: ID!, $addresses: [CartSelectableAddressInput!]!) {
      cartDeliveryAddressesReplace(cartId: $cartId, addresses: $addresses) {
        cart { id delivery { addresses { id selected } } }
        userErrors { field message code }
      }
    }
  `;

  async function setDeliveryAddress(loc) {
    const a = loc.address;
    const addressInput = {
      selected: true,
      oneTimeUse: false,
      address: {
        deliveryAddress: {
          firstName: a.firstName || "",
          lastName: a.lastName || "",
          company: a.company || loc.name,
          address1: a.address1 || "",
          address2: a.address2 || "",
          city: a.city || "",
          provinceCode: a.provinceCode || "",
          zip: a.zip || "",
          countryCode: a.countryCode || "US",
        },
      },
    };

    const mutation = hasSetAddressBefore
      ? DELIVERY_ADDRESSES_REPLACE
      : DELIVERY_ADDRESSES_ADD;
    const resultKey = hasSetAddressBefore
      ? "cartDeliveryAddressesReplace"
      : "cartDeliveryAddressesAdd";

    const data = await storefrontFetch(mutation, {
      cartId,
      addresses: [addressInput],
    });
    const errors = data?.[resultKey]?.userErrors ?? [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

    hasSetAddressBefore = true;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     QUERY — DELIVERY GROUPS
     Only flat fields confirmed to exist on CartDeliveryOption in API 2026-01
  ───────────────────────────────────────────────────────────────────────── */
  const DELIVERY_GROUPS_QUERY = `
    query CartDeliveryGroups($cartId: ID!) {
      cart(id: $cartId) {
        deliveryGroups(first: 10) {
          nodes {
            id
            groupType
            selectedDeliveryOption {
              handle title estimatedCost { amount currencyCode }
            }
            deliveryOptions {
              handle
              title
              code
              deliveryMethodType
              description
              estimatedCost { amount currencyCode }
            }
          }
        }
      }
    }
  `;

  async function fetchDeliveryGroups(retries = 5, delayMs = 1200) {
    for (let i = 0; i <= retries; i++) {
      const data = await storefrontFetch(DELIVERY_GROUPS_QUERY, { cartId });
      const groups = data?.cart?.deliveryGroups?.nodes ?? [];
      const hasRates = groups.some((g) => g.deliveryOptions?.length > 0);
      if (hasRates || i === retries) return groups;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return [];
  }

  /**
   * Scans deliveryGroups for LOCAL_PICKUP options and caches them by location
   * name so we can select them after the shipping address has been cleared.
   * Must be called while a shipping address is still set on the cart.
   */
  /**
   * Returns true if a delivery option is a pickup option.
   * Handles two cases:
   *  1. Proper LOCAL_PICKUP type (standard Shopify setup)
   *  2. Pickup configured as SHIPPING rates with "Pickup" in the title
   *     (stores where Shopify support enabled pickup as shipping rates)
   */
  function isPickupOption(opt) {
    return (
      opt.deliveryMethodType === "LOCAL_PICKUP" ||
      opt.title.toLowerCase().includes("pickup") ||
      opt.title.toLowerCase().includes("pick up")
    );
  }

  function buildPickupOptionsCache(groups) {
    pickupOptionsCache = new Map();
    groups.forEach((group) => {
      (group.deliveryOptions || []).filter(isPickupOption).forEach((o) => {
        const titleLower = o.title.toLowerCase();
        // Store under the full title
        pickupOptionsCache.set(titleLower, {
          groupId: group.id,
          handle: o.handle,
          title: o.title,
        });
        // Store under the part after " at " if present
        // e.g. "Pick up at Shop location 1" → key "shop location 1"
        const atIdx = titleLower.indexOf(" at ");
        if (atIdx !== -1) {
          const namePart = titleLower.slice(atIdx + 4).trim();
          pickupOptionsCache.set(namePart, {
            groupId: group.id,
            handle: o.handle,
            title: o.title,
          });
        }
        // Also store under numeric bracket content if present
        // e.g. "Pickup [9501409]" → key "9501409" — not useful for name
        // matching but stored anyway for completeness
      });
    });
    console.log(
      "[B2B] Pickup options cache built:",
      Array.from(pickupOptionsCache.keys()),
    );
    console.log(
      "[B2B] All delivery options seen during cache build:",
      groups
        .flatMap((g) => g.deliveryOptions || [])
        .map((o) => ({
          title: o.title,
          type: o.deliveryMethodType,
          handle: o.handle,
        })),
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
     QUERY — PICKUP LOCATIONS via cart line items → ProductVariant.storeAvailability
     Requires: unauthenticated_read_product_pickup_locations scope on token
               Local pickup enabled in Shopify Admin → Settings → Shipping
  ───────────────────────────────────────────────────────────────────────── */
  const CART_PICKUP_LOCATIONS_QUERY = `
    query CartPickupLocations($cartId: ID!) {
      cart(id: $cartId) {
        lines(first: 50) {
          nodes {
            id
            quantity
            merchandise {
              ... on ProductVariant {
                id
                storeAvailability(first: 20) {
                  nodes {
                    available
                    quantityAvailable
                    pickUpTime
                    location {
                      id
                      name
                      address {
                        address1
                        address2
                        city
                        provinceCode
                        zip
                        countryCode
                        phone
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  /**
   * Returns Map<locationId, {
   *   location,
   *   pickUpTime,
   *   allAvailable,
   *   lines: [{ variantId, quantity, quantityAvailable, available, title }]
   * }>
   * Includes ALL locations (not just fully available ones) so we can show
   * partial stock info. Callers can filter on allAvailable if needed.
   */
  async function fetchCartPickupLocations() {
    if (!cartId) return new Map();

    const data = await storefrontFetch(CART_PICKUP_LOCATIONS_QUERY, { cartId });
    const lines = data?.cart?.lines?.nodes ?? [];

    if (!lines.length) return new Map();

    const locationMap = new Map();

    lines.forEach((line) => {
      const availabilities = line.merchandise?.storeAvailability?.nodes ?? [];
      availabilities.forEach((avail) => {
        const locId = avail.location.id;

        if (!locationMap.has(locId)) {
          locationMap.set(locId, {
            location: avail.location,
            pickUpTime: avail.pickUpTime,
            allAvailable: avail.available,
            lines: [],
          });
        }

        const entry = locationMap.get(locId);
        // Track per-line stock for this location
        entry.lines.push({
          variantId: line.merchandise?.id ?? "",
          cartQty: line.quantity,
          quantityAvailable: avail.quantityAvailable,
          available: avail.available,
        });
        // Location is only fully available if ALL lines are in stock
        entry.allAvailable = entry.allAvailable && avail.available;
      });
    });

    // Return ALL locations — UI will show stock status for each
    return locationMap;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MUTATION — SELECT DELIVERY OPTION
  ───────────────────────────────────────────────────────────────────────── */
  const SELECTED_DELIVERY_UPDATE = `
    mutation CartSelectedDeliveryOptionsUpdate(
      $cartId: ID!
      $selectedDeliveryOptions: [CartSelectedDeliveryOptionInput!]!
    ) {
      cartSelectedDeliveryOptionsUpdate(
        cartId: $cartId
        selectedDeliveryOptions: $selectedDeliveryOptions
      ) {
        cart { id }
        userErrors { field message }
      }
    }
  `;

  async function onDeliveryOptionChange(e) {
    const radio = e.target;
    const handle = radio.value;
    const groupId = radio.dataset.groupId;

    document
      .querySelectorAll(".b2b-ship-to__method-label")
      .forEach((l) =>
        l.classList.remove("b2b-ship-to__method-label--selected"),
      );
    radio
      .closest(".b2b-ship-to__method-label")
      ?.classList.add("b2b-ship-to__method-label--selected");

    selectedDeliveryHandles[groupId] = handle;

    try {
      await storefrontFetch(SELECTED_DELIVERY_UPDATE, {
        cartId,
        selectedDeliveryOptions: [
          { deliveryGroupId: groupId, deliveryOptionHandle: handle },
        ],
      });
    } catch (err) {
      console.error("[B2B] Delivery option update failed:", err);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESOLVE CART ID
  ───────────────────────────────────────────────────────────────────────── */
  async function resolveCartId() {
    const res = await fetch("/cart.js");
    const cart = await res.json();
    const token = cart.token;

    if (!token) {
      console.warn("[B2B] Cart is empty, no token available yet.");
      return null;
    }

    const candidates = [`gid://shopify/Cart/${token}`, `c1-${token}`];

    for (const id of candidates) {
      try {
        const data = await storefrontFetch(
          `query CheckCart($id: ID!) { cart(id: $id) { id } }`,
          { id },
        );
        if (data?.cart?.id) return data.cart.id;
      } catch (_) {
        continue;
      }
    }

    console.warn("[B2B] Could not match token to a Storefront API cart.");
    return null;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────────────── */
  function findLocation(id) {
    return locations.find((l) => String(l.id) === String(id));
  }

  function renderAddressDisplay(loc) {
    const _addr = addressDisplay();
    if (!_addr || !loc) return;
    const a = loc.address;
    const lines = [
      loc.name,
      [a.address1, a.address2].filter(Boolean).join(", "),
      [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "),
      a.countryCode,
    ].filter(Boolean);
    _addr.innerHTML = `<address class="b2b-ship-to__address-text">${lines.join("<br>")}</address>`;
  }

  function setStatus(msg, isError = false) {
    const _status = statusEl();
    if (!_status) return;
    _status.hidden = !msg;
    _status.textContent = msg;
    _status.classList.toggle("b2b-ship-to__status--error", isError);
  }

  function setLoading(on) {
    if (select) select.disabled = on;
    setStatus(on ? "Updating…" : "");
  }

  function formatMoney(amount, currency) {
    if (parseFloat(amount) === 0) return "Free";
    return new Intl.NumberFormat(document.documentElement.lang || "en", {
      style: "currency",
      currency: currency || "USD",
    }).format(parseFloat(amount));
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RENDER — SHIP / PICKUP TOGGLE
     Injected once above the address selector inside #b2b-ship-to
  ───────────────────────────────────────────────────────────────────────── */
  function renderModeToggle() {
    if (document.getElementById("b2b-mode-toggle")) return;

    const wrapper = document.createElement("div");
    wrapper.id = "b2b-mode-toggle";
    wrapper.className = "b2b-ship-to__mode-toggle";
    wrapper.innerHTML = `
      <button type="button" id="b2b-mode-ship"
        class="b2b-ship-to__mode-btn b2b-ship-to__mode-btn--active"
        aria-pressed="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
             viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.75" aria-hidden="true">
          <rect x="1" y="3" width="15" height="13" rx="1"/>
          <path d="M16 8h4l3 4v5h-7V8z"/>
          <circle cx="5.5" cy="18.5" r="2.5"/>
          <circle cx="18.5" cy="18.5" r="2.5"/>
        </svg>
        Ship
      </button>
      <button type="button" id="b2b-mode-pickup"
        class="b2b-ship-to__mode-btn"
        aria-pressed="false">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
             viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.75" aria-hidden="true">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
          <circle cx="12" cy="9" r="2.5"/>
        </svg>
        Pickup
      </button>
    `;

    const container = document.getElementById("b2b-ship-to");
    if (container) container.insertBefore(wrapper, container.firstChild);

    document
      .getElementById("b2b-mode-ship")
      .addEventListener("click", () => switchMode("ship"));
    document
      .getElementById("b2b-mode-pickup")
      .addEventListener("click", () => switchMode("pickup"));
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SWITCH MODE — ship ↔ pickup
  ───────────────────────────────────────────────────────────────────────── */
  async function switchMode(mode) {
    if (mode === activeMode) return;
    activeMode = mode;
    console.log("Switching mode:", mode);
    const shipBtn = document.getElementById("b2b-mode-ship");
    const pickupBtn = document.getElementById("b2b-mode-pickup");
    const container = document.getElementById("b2b-ship-to");

    if (mode === "ship") {
      shipBtn?.classList.add("b2b-ship-to__mode-btn--active");
      shipBtn?.setAttribute("aria-pressed", "true");
      pickupBtn?.classList.remove("b2b-ship-to__mode-btn--active");
      pickupBtn?.setAttribute("aria-pressed", "false");

      // Remove pickup-mode class → CSS shows ship UI, hides pickup panel
      container?.classList.remove("b2b-ship-to--pickup-mode");
      hidePickupPanel();

      if (cartId) {
        // Tell checkout: ship mode — Delivery Customization Function will show all options
        await fetch("/cart/update.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attributes: { delivery_mode: "ship" } }),
        });

        setStatus("Loading shipping options…");
        try {
          // Restore the shipping address on the cart
          const loc = findLocation(select.value);
          if (loc) {
            hasSetAddressBefore = false;
            await setDeliveryAddress(loc);
            renderAddressDisplay(loc);
          }
          const groups = await fetchDeliveryGroups();
          renderShippingMethods(groups);
          setStatus("");
        } catch (err) {
          setStatus("Could not load shipping rates.", true);
          console.error("[B2B] Ship mode error:", err);
        }
      }
    } else {
      // pickup mode
      pickupBtn?.classList.add("b2b-ship-to__mode-btn--active");
      pickupBtn?.setAttribute("aria-pressed", "true");
      shipBtn?.classList.remove("b2b-ship-to__mode-btn--active");
      shipBtn?.setAttribute("aria-pressed", "false");

      // Add pickup-mode class → CSS hides ship UI, shows pickup panel
      container?.classList.add("b2b-ship-to--pickup-mode");

      // Tell checkout: pickup mode — Delivery Customization Function will hide shipping options
      if (cartId) {
        await fetch("/cart/update.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attributes: { delivery_mode: "pickup" } }),
        }).catch((err) =>
          console.warn("[B2B] Could not set cart attribute:", err),
        );
      }

      setStatus("Loading pickup locations…");
      try {
        const pickupMap = await fetchCartPickupLocations();
        console.log(
          "[B2B] Pickup locations fetched:",
          Array.from(pickupMap.keys()),
        );

        if (cartId && pickupMap.size > 0) {
          // STEP 1: Select the LOCAL_PICKUP delivery option FIRST while the
          // shipping address is still on the cart. Shopify needs an active
          // delivery context to accept cartSelectedDeliveryOptionsUpdate.
          const firstEntry = Array.from(pickupMap.values())[0];
          await selectPickupDeliveryOption(firstEntry.location.id, pickupMap);

          // STEP 2: NOW clear the shipping address. The delivery option is
          // already locked to LOCAL_PICKUP so checkout will open in Pickup mode.
          await storefrontFetch(DELIVERY_ADDRESSES_REPLACE, {
            cartId,
            addresses: [],
          });
          hasSetAddressBefore = false;
          console.log(
            "[B2B] Delivery set to LOCAL_PICKUP, shipping address cleared",
          );
        }

        renderPickupLocations(pickupMap);
        setStatus("");
      } catch (err) {
        setStatus("Could not load pickup locations.", true);
        console.error("[B2B] Pickup mode error:", err);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RENDER — SHIPPING METHODS (ship mode only)
  ───────────────────────────────────────────────────────────────────────── */
  function renderShippingMethods(groups) {
    // Don't render if user has already switched to pickup mode
    if (activeMode === "pickup") return;
    const _panel = methodsPanel();
    const _list = methodsList();
    if (!_panel || !_list) return;

    _list.innerHTML = "";

    // Show only true shipping options — exclude LOCAL_PICKUP type AND
    // any option whose title contains "pickup" (handles stores where pickup
    // was configured as shipping rates by Shopify support)
    const options = groups.flatMap((g) =>
      (g.deliveryOptions || [])
        .filter((o) => !isPickupOption(o))
        .map((opt) => ({
          ...opt,
          groupId: g.id,
          isSelected: g.selectedDeliveryOption?.handle === opt.handle,
        })),
    );

    if (!options.length) {
      _panel.hidden = false;
      const _none = methodsNone();
      if (_none) _none.hidden = false;
      return;
    }

    const _none2 = methodsNone();
    if (_none2) _none2.hidden = true;
    _panel.hidden = false;

    options.forEach((opt) => {
      const item = document.createElement("div");
      item.className = "b2b-ship-to__method-item";
      item.innerHTML = `
        <label class="b2b-ship-to__method-label${opt.isSelected ? " b2b-ship-to__method-label--selected" : ""}">
          <input
            type="radio"
            class="b2b-ship-to__method-radio"
            name="b2b-delivery-${opt.groupId}"
            value="${opt.handle}"
            data-group-id="${opt.groupId}"
            data-method-type="${opt.deliveryMethodType}"
            ${opt.isSelected ? "checked" : ""}
          >
          <span class="b2b-ship-to__method-icon" aria-hidden="true">🚚</span>
          <span class="b2b-ship-to__method-info">
            <span class="b2b-ship-to__method-title">${opt.title}</span>
            ${
              opt.description
                ? `<span class="b2b-ship-to__method-desc">${opt.description}</span>`
                : ""
            }
          </span>
          <span class="b2b-ship-to__method-cost">
            ${formatMoney(opt.estimatedCost?.amount, opt.estimatedCost?.currencyCode)}
          </span>
        </label>`;
      item
        .querySelector("input")
        .addEventListener("change", onDeliveryOptionChange);
      _list.appendChild(item);
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RENDER — PICKUP LOCATIONS (pickup mode only)
  ───────────────────────────────────────────────────────────────────────── */
  function renderPickupLocations(pickupMap) {
    hidePickupPanel();

    const panel = document.createElement("div");
    panel.id = "b2b-pickup-panel";
    panel.className = "b2b-ship-to__pickup-panel";

    const allEntries = Array.from(pickupMap.values());
    const available = allEntries.filter((e) => e.allAvailable);
    const unavailable = allEntries.filter((e) => !e.allAvailable);

    if (pickupMap.size === 0) {
      panel.innerHTML = `
        <p class="b2b-ship-to__pickup-none">
          No pickup locations found for items in your cart.
        </p>`;
    } else {
      const renderCard = (entry, index, isAvailable) => {
        const loc = entry.location;
        const a = loc.address;
        const addr = [a.address1, a.city, a.provinceCode]
          .filter(Boolean)
          .join(", ");

        const stockRows = (entry.lines || [])
          .map((line) => {
            const qty = line.quantityAvailable;
            const needed = line.cartQty;
            const enough = qty >= needed;
            if (!line.available) {
              return `<span class="b2b-stock__row"><span class="b2b-stock__qty b2b-stock__qty--out">Out of stock</span></span>`;
            }
            if (!enough) {
              return `<span class="b2b-stock__row"><span class="b2b-stock__qty b2b-stock__qty--low">${qty} in stock (you need ${needed})</span></span>`;
            }
            return `<span class="b2b-stock__row"><span class="b2b-stock__qty b2b-stock__qty--ok">${qty} in stock</span></span>`;
          })
          .join("");

        const isFirst = isAvailable && index === 0;

        return `
          <label class="b2b-ship-to__pickup-label${isAvailable ? "" : " b2b-ship-to__pickup-label--unavailable"}">
            <input
              type="radio"
              class="b2b-ship-to__pickup-radio"
              name="b2b-pickup-location"
              value="${loc.id}"
              data-location-id="${loc.id}"
              ${isFirst ? "checked" : ""}
              ${isAvailable ? "" : "disabled"}
            >
            <span class="b2b-ship-to__pickup-info">
              <span class="b2b-ship-to__pickup-name">${loc.name}</span>
              <span class="b2b-ship-to__pickup-addr">${addr}</span>
              ${
                entry.pickUpTime && isAvailable
                  ? `<span class="b2b-ship-to__pickup-time">${entry.pickUpTime}</span>`
                  : ""
              }
              <span class="b2b-stock">${stockRows}</span>
            </span>
            ${
              isAvailable
                ? `<span class="b2b-ship-to__pickup-badge">FREE</span>`
                : `<span class="b2b-ship-to__pickup-badge b2b-ship-to__pickup-badge--unavailable">Unavailable</span>`
            }
          </label>`;
      };

      const availableHTML = available
        .map((e, i) => renderCard(e, i, true))
        .join("");
      const unavailableHTML = unavailable
        .map((e, i) => renderCard(e, i, false))
        .join("");
      const countLabel =
        available.length === 0
          ? "No locations have all items in stock"
          : `${available.length} location${available.length > 1 ? "s" : ""} with your items in stock`;

      panel.innerHTML = `
        <p class="b2b-ship-to__pickup-count">${countLabel}</p>
        <div class="b2b-ship-to__pickup-list" role="radiogroup" aria-label="Pickup location">
          ${availableHTML}
          ${unavailableHTML ? `<p class="b2b-ship-to__pickup-unavail-heading">Not available at:</p>${unavailableHTML}` : ""}
        </div>`;

      const firstAvail = available[0];
      if (firstAvail && cartId) {
        selectPickupDeliveryOption(firstAvail.location.id, pickupMap);
      }
    }

    const toggle = document.getElementById("b2b-mode-toggle");
    toggle?.insertAdjacentElement("afterend", panel);

    panel
      .querySelector(
        ".b2b-ship-to__pickup-label:not(.b2b-ship-to__pickup-label--unavailable)",
      )
      ?.classList.add("b2b-ship-to__pickup-label--selected");

    panel
      .querySelectorAll(".b2b-ship-to__pickup-radio:not([disabled])")
      .forEach((radio) => {
        radio.addEventListener("change", (e) => {
          panel
            .querySelectorAll(".b2b-ship-to__pickup-label")
            .forEach((l) =>
              l.classList.remove("b2b-ship-to__pickup-label--selected"),
            );
          e.target
            .closest(".b2b-ship-to__pickup-label")
            ?.classList.add("b2b-ship-to__pickup-label--selected");
          selectPickupDeliveryOption(e.target.value, pickupMap);
        });
      });
  }

  function hidePickupPanel() {
    document.getElementById("b2b-pickup-panel")?.remove();
  }

  /**
   * Select the pickup delivery option for the chosen location.
   * Uses PICKUP_HANDLE_MAP first (hardcoded locationGid → handle mapping)
   * which is 100% reliable. Falls back to cache if map lookup fails.
   */
  async function selectPickupDeliveryOption(locationId, pickupMap) {
    if (!cartId) return;

    const entry = pickupMap.get(locationId);
    const locName = entry?.location?.name ?? "";
    console.log(
      "[B2B] Selecting pickup for location:",
      locName,
      "id:",
      locationId,
    );

    try {
      // PRIMARY: Direct lookup by locationId in hardcoded map
      let match = PICKUP_HANDLE_MAP[locationId];

      if (match) {
        console.log(
          "[B2B] Direct map match:",
          match.title,
          "handle:",
          match.handle,
        );
      } else {
        // FALLBACK: Try pickupOptionsCache built from deliveryGroups
        console.warn(
          "[B2B] Location not in PICKUP_HANDLE_MAP, trying cache...",
        );
        const locNameLower = locName.toLowerCase();
        const cacheValues = Array.from(pickupOptionsCache.values());

        if (pickupOptionsCache.size === 0) {
          const groups = await fetchDeliveryGroups();
          buildPickupOptionsCache(groups);
        }

        const cached =
          pickupOptionsCache.get(locNameLower) ||
          Array.from(pickupOptionsCache.entries()).find(([k]) =>
            k.includes(locNameLower),
          )?.[1] ||
          Array.from(pickupOptionsCache.entries()).find(([k]) =>
            locNameLower.includes(k),
          )?.[1] ||
          (pickupOptionsCache.size === 1
            ? Array.from(pickupOptionsCache.values())[0]
            : null);

        if (cached) {
          match = cached;
        } else {
          console.error("[B2B] No match found for location:", locName);
          return;
        }
      }

      // We need the groupId — fetch it from deliveryGroups
      // (the map only stores handle+title, groupId comes from current cart)
      const data = await storefrontFetch(DELIVERY_GROUPS_QUERY, { cartId });
      const groups = data?.cart?.deliveryGroups?.nodes ?? [];
      let groupId = match.groupId; // may already be set from cache

      if (!groupId) {
        for (const group of groups) {
          const found = (group.deliveryOptions || []).find(
            (o) => o.handle === match.handle,
          );
          if (found) {
            groupId = group.id;
            break;
          }
        }
      }

      if (!groupId) {
        console.error("[B2B] Could not find groupId for handle:", match.handle);
        return;
      }

      await storefrontFetch(SELECTED_DELIVERY_UPDATE, {
        cartId,
        selectedDeliveryOptions: [
          { deliveryGroupId: groupId, deliveryOptionHandle: match.handle },
        ],
      });
      console.log(
        "[B2B] Pickup selected:",
        match.title,
        "handle:",
        match.handle,
      );
    } catch (err) {
      console.error("[B2B] selectPickupDeliveryOption failed:", err);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LOCATION DROPDOWN CHANGE
  ───────────────────────────────────────────────────────────────────────── */
  async function onLocationChange(e) {
    const loc = findLocation(e.target.value);
    if (!loc) return;

    try {
      setLoading(true);
      await switchShopifyLocation(loc);
      cartId = await resolveCartId();
      hasSetAddressBefore = false;

      if (cartId) {
        if (activeMode === "ship") {
          await setDeliveryAddress(loc);
          renderAddressDisplay(loc);
          const groups = await fetchDeliveryGroups();
          // Rebuild cache with fresh LOCAL_PICKUP options for new location context
          buildPickupOptionsCache(groups);
          renderShippingMethods(groups);
        } else {
          const pickupMap = await fetchCartPickupLocations();
          renderPickupLocations(pickupMap);
        }
      } else {
        renderAddressDisplay(loc);
      }

      setLoading(false);
      setStatus(
        activeMode === "ship"
          ? `Shipping to ${loc.name}.`
          : "Pickup locations updated.",
      );
      setTimeout(() => setStatus(""), 4000);
    } catch (err) {
      setLoading(false);
      setStatus("Failed to update. Please try again.", true);
      console.error("[B2B]", err);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────────────────── */
  async function init() {
    try {
      cartId = await resolveCartId();

      // Always render the toggle regardless of cart state
      renderModeToggle();

      if (!cartId) {
        renderAddressDisplay(findLocation(currentLocationId));
        select.addEventListener("change", onLocationChange);
        return;
      }

      // STEP 1: Set delivery address FIRST so Shopify computes delivery options
      // including LOCAL_PICKUP. Without an address, deliveryGroups returns no options.
      if (currentLocationId) {
        const loc = findLocation(currentLocationId);
        if (loc) {
          await setDeliveryAddress(loc);
          renderAddressDisplay(loc);
        }
      }

      // STEP 2: Now fetch delivery groups — address is set so LOCAL_PICKUP options
      // are included. Fetch pickup locations in parallel since they don't depend on
      // delivery groups.
      const [groups, pickupMap] = await Promise.all([
        fetchDeliveryGroups(),
        fetchCartPickupLocations(),
      ]);

      // STEP 3: Build the pickup options cache from the groups — this works now
      // because the address was set before fetching groups.
      buildPickupOptionsCache(groups);

      renderShippingMethods(groups);
      select.addEventListener("change", onLocationChange);
    } catch (err) {
      setStatus("Shipping rates will be shown at checkout.", false);
      console.error("[B2B] Init error:", err);
      select.addEventListener("change", onLocationChange);
    }
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();
})();
