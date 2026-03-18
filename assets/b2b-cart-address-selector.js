//@ts-nocheck

(function B2BCartAddressSelector() {
  const API_VERSION = "2025-01";

  // These come from window.__b2b emitted by Liquid — no change needed there
  const { shopDomain, storefrontToken, locations, cartId, currentLocationId } =
    window.__b2b;

  const select = document.getElementById("b2b-location-select");
  const addressDisplay = document.getElementById("b2b-address-display");
  const statusEl = document.getElementById("b2b-status");
  const methodsPanel = document.getElementById("b2b-shipping-methods");
  const methodsList = document.getElementById("b2b-methods-list");
  const methodsNone = document.getElementById("b2b-methods-none");

  if (!select || !window.__b2b) return;

  let hasSetAddressBefore = false;
  let selectedDeliveryHandles = {};

  /* ── Storefront API fetch (no auth header needed beyond the public token) ── */
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

  /* ── Step 1: Switch session location via native Shopify endpoint ─────────
     This is a standard GET redirect. We follow it silently with fetch.
     Shopify updates the server-side session → cart gets correct B2B pricing,
     catalog, and payment terms. No token needed. No app needed.            */
  async function switchShopifyLocation(loc) {
    const url = new URL(loc.urlToSet, window.location.origin);
    url.searchParams.set("return_to", window.location.pathname);
    await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      credentials: "include",
    });
  }

  /* ── Step 2: Set the delivery address on the cart ────────────────────────
     cartDeliveryAddressesAdd / Replace — only needs cartId.
     No customerAccessToken required.                                        */
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

  /* ── Step 3: Fetch shipping rates ────────────────────────────────────────
     The cart's deliveryGroups are available to any holder of the cartId.
     No token needed.                                                         */
  const DELIVERY_GROUPS_QUERY = `
    query CartDeliveryGroups($cartId: ID!) {
      cart(id: $cartId) {
        deliveryGroups(first: 10) {
          nodes {
            id groupType
            selectedDeliveryOption { handle title estimatedCost { amount currencyCode } }
            deliveryOptions {
              handle title code deliveryMethodType description
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

  /* ── Step 4: Select a shipping method ───────────────────────────────────
     Also only needs cartId — no token.                                      */
  const SELECTED_DELIVERY_UPDATE = `
    mutation CartSelectedDeliveryOptionsUpdate(
      $cartId: ID!
      $selectedDeliveryOptions: [CartSelectedDeliveryOptionInput!]!
    ) {
      cartSelectedDeliveryOptionsUpdate(cartId: $cartId, selectedDeliveryOptions: $selectedDeliveryOptions) {
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

  /* ── Render helpers (unchanged from original) ────────────────────────── */
  function findLocation(id) {
    return locations.find((l) => String(l.id) === String(id));
  }

  function renderAddressDisplay(loc) {
    if (!addressDisplay || !loc) return;
    const a = loc.address;
    const lines = [
      loc.name,
      [a.address1, a.address2].filter(Boolean).join(", "),
      [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "),
      a.countryCode,
    ].filter(Boolean);
    addressDisplay.innerHTML = `<address class="b2b-ship-to__address-text">${lines.join("<br>")}</address>`;
  }

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("b2b-ship-to__status--error", isError);
  }

  function setLoading(on) {
    if (select) select.disabled = on;
    setStatus(on ? "Updating shipping address…" : "");
  }

  function formatMoney(amount, currency) {
    if (parseFloat(amount) === 0) return "Free";
    return new Intl.NumberFormat(document.documentElement.lang || "en", {
      style: "currency",
      currency: currency || "USD",
    }).format(parseFloat(amount));
  }

  function renderShippingMethods(groups) {
    if (!methodsPanel || !methodsList) return;
    methodsList.innerHTML = "";
    const icons = { SHIPPING: "🚚", LOCAL_PICKUP: "🏪", PICK_UP_POINT: "📦" };
    const options = groups.flatMap((g) =>
      (g.deliveryOptions || []).map((opt) => ({
        ...opt,
        groupId: g.id,
        isSelected: g.selectedDeliveryOption?.handle === opt.handle,
      })),
    );

    if (!options.length) {
      methodsPanel.hidden = false;
      methodsNone.hidden = false;
      return;
    }

    methodsNone.hidden = true;
    methodsPanel.hidden = false;

    options.forEach((opt) => {
      const item = document.createElement("div");
      item.className = "b2b-ship-to__method-item";
      item.innerHTML = `
        <label class="b2b-ship-to__method-label${opt.isSelected ? " b2b-ship-to__method-label--selected" : ""}">
          <input type="radio" class="b2b-ship-to__method-radio"
            name="b2b-delivery-${opt.groupId}"
            value="${opt.handle}"
            data-group-id="${opt.groupId}"
            ${opt.isSelected ? "checked" : ""}>
          <span class="b2b-ship-to__method-icon" aria-hidden="true">${icons[opt.deliveryMethodType] || "📦"}</span>
          <span class="b2b-ship-to__method-info">
            <span class="b2b-ship-to__method-title">${opt.title}</span>
            ${opt.description ? `<span class="b2b-ship-to__method-desc">${opt.description}</span>` : ""}
          </span>
          <span class="b2b-ship-to__method-cost">${formatMoney(opt.estimatedCost?.amount, opt.estimatedCost?.currencyCode)}</span>
        </label>`;
      item
        .querySelector("input")
        .addEventListener("change", onDeliveryOptionChange);
      methodsList.appendChild(item);
    });
  }

  /* ── Location change handler ─────────────────────────────────────────── */
  async function onLocationChange(e) {
    const loc = findLocation(e.target.value);
    if (!loc) return;
    try {
      setLoading(true);
      await switchShopifyLocation(loc); // 1. switch session (no token)
      await setDeliveryAddress(loc); // 2. set address on cart (no token)
      renderAddressDisplay(loc); // 3. update UI
      const groups = await fetchDeliveryGroups(); // 4. fetch rates (no token)
      renderShippingMethods(groups); // 5. render rates
      setLoading(false);
      setStatus(`Shipping to ${loc.name}.`);
      setTimeout(() => setStatus(""), 4000);
    } catch (err) {
      setLoading(false);
      setStatus("Failed to update address. Please try again.", true);
      console.error("[B2B]", err);
    }
  }

  /* ── Init ────────────────────────────────────────────────────────────── */
  async function init() {
    try {
      // Set address for current location on load
      if (currentLocationId) {
        const loc = findLocation(currentLocationId);
        if (loc) {
          await setDeliveryAddress(loc);
          renderAddressDisplay(loc);
        }
      }
      // Load shipping rates
      const groups = await fetchDeliveryGroups();
      renderShippingMethods(groups);
      // Wire up dropdown
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
