// createOrder.js (Appwrite Function) - Create order for COD or Razorpay and save shipping as short string + shipping_json
// ESM-compatible (node-appwrite named exports)
import Razorpay from "razorpay";
import { Client as AppwriteClient, Databases, Query, ID } from "node-appwrite";

const createRazorpayClient = () =>
    new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

const normalizeStr = (v) => (typeof v === "string" ? v.trim() : v);
const TRUNCATE_ITEM = 9999; // for items elements (Appwrite limit you experienced)
const TRUNCATE_SHIPPING = 999; // shipping column limit per your error

const stringifyItem = (it) => {
    try {
        if (it === null || typeof it === "undefined") return "";
        if (typeof it === "string") return it.slice(0, TRUNCATE_ITEM);
        if (typeof it === "number" || typeof it === "boolean") return String(it).slice(0, TRUNCATE_ITEM);

        // object: create readable label
        const name = it.name || it.title || it.productId || it.id || "item";
        const price = (typeof it.price !== "undefined" ? it.price : it.amount) || null;
        const size = it.size || it.s || it.sizeOption || it.item_size || null;
        const sizeLabel = size ? ` (Size: ${size})` : "";
        const priceLabel = price ? ` - ₹${price}` : "";
        const label = `${name}${sizeLabel}${priceLabel}`;
        const final = label && label.length > 3 ? label : JSON.stringify(it || {});
        return final.length > TRUNCATE_ITEM ? final.slice(0, TRUNCATE_ITEM) : final;
    } catch (e) {
        const s = JSON.stringify(it || {});
        return s.length > TRUNCATE_ITEM ? s.slice(0, TRUNCATE_ITEM) : s;
    }
};

// Build a short human-readable shipping string (for shipping column)
const buildShippingShort = (s) => {
    try {
        if (!s) return "";
        const parts = [];
        if (s.fullName || s.full_name) parts.push(s.fullName || s.full_name);
        if (s.line1 || s.line_1) parts.push(s.line1 || s.line_1);
        if (s.line2 || s.line_2) parts.push(s.line2 || s.line_2);
        if (s.city) parts.push(s.city);
        if (s.state) parts.push(s.state);
        if (s.postalCode || s.postal_code) parts.push(s.postalCode || s.postal_code);
        if (s.phone) parts.push(`Ph: ${s.phone}`);
        const joined = parts.join(", ");
        return joined.length > TRUNCATE_SHIPPING ? joined.slice(0, TRUNCATE_SHIPPING) : joined;
    } catch {
        return String(s).slice(0, TRUNCATE_SHIPPING);
    }
};

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ createOrder function started");

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("createOrder function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        const body = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();

        // Accept both camelCase and snake_case client keys
        const {
            amount,
            currency = "INR",
            userId,
            items = [],
            paymentMethod,
            payment_method,
            shipping = null,
            shippingPrimaryIndex = 0,
        } = body || {};

        const pm = (paymentMethod || payment_method || "razorpay").toLowerCase();

        // REQUIRE userId if your collection enforces it
        if (!userId) {
            return res.json({ success: false, message: "userId is required. Please login and send userId." }, 400);
        }

        // Normalize shipping into array
        let shippingArray = [];
        if (Array.isArray(shipping)) shippingArray = shipping;
        else if (shipping && typeof shipping === "object") shippingArray = [shipping];
        else shippingArray = [];

        if (shippingArray.length === 0) {
            return res.json({ success: false, message: "shipping is required. Provide shipping object/array." }, 400);
        }

        const primaryIndex = Number.isInteger(shippingPrimaryIndex) ? shippingPrimaryIndex : 0;
        const primaryShipping = shippingArray[primaryIndex] || shippingArray[0] || {};

        // Flatten shipping fields
        const shipping_full_name = normalizeStr(primaryShipping.fullName || primaryShipping.full_name) || null;
        const shipping_phone = normalizeStr(primaryShipping.phone) || null;
        const shipping_line_1 = normalizeStr(primaryShipping.line1 || primaryShipping.line_1) || null;
        const shipping_line_2 = normalizeStr(primaryShipping.line2 || primaryShipping.line_2) || null;
        const shipping_city = normalizeStr(primaryShipping.city) || null;
        const shipping_state = normalizeStr(primaryShipping.state) || null;
        const shipping_postal_code = normalizeStr(primaryShipping.postalCode || primaryShipping.postal_code) || null;
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

        // derive required top-level size from items or client
        let primarySize = null;
        if (Array.isArray(items) && items.length > 0) {
            const first = items[0];
            if (first && (first.size || first.s || first.sizeOption || first.item_size)) {
                primarySize = String(first.size || first.s || first.sizeOption || first.item_size);
            } else {
                const found = items.find((it) => it && (it.size || it.s || it.sizeOption || it.item_size));
                if (found) primarySize = String(found.size || found.s || found.sizeOption || found.item_size);
            }
        }
        if (!primarySize) {
            return res.json({ success: false, message: "size is required (e.g. send size in items[0].size)." }, 400);
        }

        if (pm === "razorpay") {
            if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
                return res.json({ success: false, message: "Valid amount (in rupees) required for razorpay orders" }, 400);
            }
        }

        // create razorpay order if required
        let razorpayOrder = null;
        let razorpay_order_id = null;
        const amountPaiseFromClient = Math.round(Number(amount || 0) * 100);
        let amountPaise = amountPaiseFromClient;

        if (pm === "razorpay") {
            if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
                return res.json({ success: false, message: "Razorpay credentials not configured" }, 500);
            }
            const razorpay = createRazorpayClient();
            razorpayOrder = await razorpay.orders.create({
                amount: amountPaise,
                currency,
                receipt: `order_rcpt_${Date.now()}`,
            });
            razorpay_order_id = razorpayOrder.id;
            amountPaise = razorpayOrder.amount;
            log("✅ Razorpay order created:", razorpay_order_id);
        } else {
            // COD -> generate a canonical id for collection
            razorpay_order_id = `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            amountPaise = amountPaiseFromClient;
        }

        // Create itemsForColumn (array of strings) and items_json (full JSON)
        const itemsForColumn = Array.isArray(items)
            ? items.map((it) => {
                const s = stringifyItem(it);
                return typeof s === "string" ? (s.length > TRUNCATE_ITEM ? s.slice(0, TRUNCATE_ITEM) : s) : String(s).slice(0, TRUNCATE_ITEM);
            })
            : [];
        const items_json = JSON.stringify(items || []);

        // shipping short string and full json
        const shipping_short = buildShippingShort(primaryShipping) || "";
        const shipping_json = JSON.stringify(shippingArray || []);

        // Appwrite config
        const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
        const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const APPWRITE_ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        let savedOrderDoc = null;
        if (APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID && APPWRITE_API_KEY && APPWRITE_DATABASE_ID && APPWRITE_ORDERS_COLLECTION_ID) {
            try {
                log("🔁 Initializing Appwrite client for saving order");
                const client = new AppwriteClient().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
                const databases = new Databases(client);

                const canonicalOrderId = razorpay_order_id;
                const payload = {
                    // use order_id (snake_case) as per your collection
                    order_id: canonicalOrderId,

                    // required fields
                    userId: userId,
                    amount: amountPaise,
                    amountPaise: amountPaise,
                    currency: currency,

                    // razorpay
                    razorpay_order_id: razorpay_order_id,

                    // items as array of short strings, full JSON in items_json
                    items: itemsForColumn,
                    items_json: items_json,

                    // payment/status
                    payment_method: pm,
                    status: pm === "cod" ? "pending" : "created",

                    // shipping: short string (fits Appwrite string col) + full json in shipping_json
                    shipping: shipping_short,       // <-- MATCHES your current collection: string <= 999 chars
                    shipping_json: shipping_json,   // <-- full JSON string (Text field recommended)

                    // flattened fields for indexing
                    shipping_full_name,
                    shipping_phone,
                    shipping_line_1,
                    // shipping_line_2,
                    shipping_city,
                    shipping_postal_code,
                    shipping_country,

                    // required size
                    size: primarySize,

                    // metadata
                    receipt: razorpayOrder?.receipt || null,
                    verification_raw: JSON.stringify({ razorpayOrder: razorpayOrder || null }),
                };

                // Try to find existing document by razorpay_order_id to avoid duplicates
                let existing = null;
                try {
                    const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, [
                        Query.equal("razorpay_order_id", razorpay_order_id),
                        Query.limit(1),
                    ]);
                    existing = (list?.documents || [])[0] || null;
                } catch (qErr) {
                    log("Query existing order failed (will create):", qErr.message || qErr);
                }

                if (existing) {
                    log("🔄 Updating existing Appwrite order doc:", existing.$id);
                    savedOrderDoc = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, existing.$id, payload);
                } else {
                    log("➕ Creating new Appwrite order doc");
                    savedOrderDoc = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, ID.unique(), payload);
                }

                log("✅ Order saved to Appwrite orders collection:", savedOrderDoc.$id || savedOrderDoc.id || "(no id)");
            } catch (dbErr) {
                error("Error saving order to Appwrite DB:", dbErr.message || dbErr);
                return res.json({ success: false, message: "Failed saving order to DB", error: String(dbErr) }, 500);
            }
        } else {
            log("ℹ️ Appwrite DB env not fully configured — skipping DB save");
        }

        return res.json({
            success: true,
            payment_method: pm,
            razorpay_order_id: razorpay_order_id,
            amount: amountPaise,
            currency,
            razorpayOrder: razorpayOrder || null,
            savedOrderDoc: savedOrderDoc || null,
        });
    } catch (err) {
        error("Critical error in createOrder:", err.message || err);
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
