// verifyPayment.js - verifies Razorpay signature and updates/creates order doc (includes shipping + size)
import Razorpay from "razorpay";
import { Client, Databases, Query, ID } from "node-appwrite";
import crypto from "crypto";

/** safe JSON parse that tolerates strings/objects */
const safeParse = (raw) => {
    try {
        if (!raw) return {};
        if (typeof raw === "string") return JSON.parse(raw);
        if (typeof raw === "object") return raw;
    } catch {
        try {
            return JSON.parse(String(raw || "{}"));
        } catch {
            return {};
        }
    }
    return {};
};

const makeRazorpayClient = () => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
        throw new Error("Missing Razorpay credentials in function env (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
    }
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const normalizeStr = (v) => (typeof v === "string" ? v.trim() : v);

export default async ({ req, res, log, error }) => {
    log("verifyPayment invoked");
    try {
        if (req.method !== "POST") return res.json({ success: false, message: "Method not allowed" }, 405);

        // Accept many payload shapes
        const raw =
            req.bodyRaw ||
            req.payload ||
            req.variables?.APPWRITE_FUNCTION_DATA ||
            req.headers?.["x-appwrite-function-data"] ||
            "{}";

        let bodyData = safeParse(raw);
        if (typeof bodyData.body === "string") Object.assign(bodyData, safeParse(bodyData.body));
        if (typeof bodyData.data === "string") Object.assign(bodyData, safeParse(bodyData.data));

        // prefer top-level keys (client should send these)
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            userId,
            items,
            amount: amountFromClient,
            currency = "INR",
            shipping: shippingFromClient,
            shippingPrimaryIndex,
        } = bodyData || {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ success: false, message: "Missing required payment fields" }, 400);
        }

        // Ensure Razorpay env exists
        if (!process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_KEY_ID) {
            error("Missing Razorpay env vars");
            return res.json({ success: false, message: "Server misconfiguration: missing Razorpay credentials" }, 500);
        }

        // Verify signature
        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
            log("Signature mismatch", { generatedSignature, razorpay_signature });
            return res.json({ success: false, message: "Invalid signature" }, 400);
        }

        // Instantiate Razorpay client
        const razorpay = makeRazorpayClient();

        // Try to fetch payment details (non-fatal)
        let paymentDetails = null;
        try {
            paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
            log("Fetched payment details:", paymentDetails?.id);
        } catch (fetchErr) {
            log("Could not fetch payment details:", fetchErr.message || fetchErr);
        }

        // Optional amount verification
        if (typeof amountFromClient !== "undefined" && paymentDetails?.amount !== undefined) {
            let expectedPaise = Number(amountFromClient);
            // Try to detect rupees vs paise
            if (expectedPaise > 1000000) {
                // probably already paise
            } else if (expectedPaise < 1000) {
                // small rupee value -> convert
                expectedPaise = Math.round(expectedPaise * 100);
            } else {
                // ambiguous rupee value: convert to paise
                expectedPaise = Math.round(expectedPaise * 100);
            }
            if (Number(paymentDetails.amount) !== expectedPaise) {
                log("Amount mismatch", { expectedPaise, actual: paymentDetails.amount });
                return res.json({ success: false, message: "Payment amount mismatch" }, 400);
            }
        }

        // Appwrite init
        const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
        // Accept x-appwrite-key header for admin key (preferred), else fallback to env var
        const APPWRITE_API_KEY = req.headers?.["x-appwrite-key"] || process.env.APPWRITE_API_KEY;
        const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const APPWRITE_ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID || !APPWRITE_ORDERS_COLLECTION_ID) {
            error("Missing Appwrite DB env vars");
            return res.json({ success: false, message: "Server misconfiguration: missing Appwrite config" }, 500);
        }

        const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
        const databases = new Databases(client);

        // Find existing order doc by razorpay_order_id
        let existingDoc = null;
        try {
            const listRes = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, [
                Query.equal("razorpay_order_id", razorpay_order_id),
                Query.limit(1),
            ]);
            existingDoc = listRes.documents?.[0] || null;
        } catch (listErr) {
            log("listDocuments error (continuing):", listErr.message || listErr);
        }

        // Normalize shipping: prefer existing doc shipping, then client-provided shipping, else empty array
        let shippingArray = [];
        if (existingDoc && existingDoc.shipping) {
            if (Array.isArray(existingDoc.shipping)) shippingArray = existingDoc.shipping;
            else if (existingDoc.shipping && typeof existingDoc.shipping === "object") shippingArray = [existingDoc.shipping];
        } else if (shippingFromClient) {
            if (Array.isArray(shippingFromClient)) shippingArray = shippingFromClient;
            else if (shippingFromClient && typeof shippingFromClient === "object") shippingArray = [shippingFromClient];
        } else {
            shippingArray = [];
        }

        const primaryIndex = Number.isInteger(shippingPrimaryIndex) ? shippingPrimaryIndex : 0;
        const primaryShipping = shippingArray[primaryIndex] || shippingArray[0] || {};

        // Flatten shipping for indexing and required fields
        const shipping_full_name = normalizeStr(primaryShipping.fullName || primaryShipping.full_name) || null;
        const shipping_phone = normalizeStr(primaryShipping.phone) || null;
        const shipping_line_1 = normalizeStr(primaryShipping.line1 || primaryShipping.line_1) || null;
        const shipping_line_2 = normalizeStr(primaryShipping.line2 || primaryShipping.line_2) || null;
        const shipping_city = normalizeStr(primaryShipping.city) || null;
        const shipping_state = normalizeStr(primaryShipping.state) || null;
        const shipping_postal_code = normalizeStr(primaryShipping.postalCode || primaryShipping.postal_code) || null;
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

        // Determine size: prefer existingDoc.size, else look into items array
        let size = null;
        if (existingDoc && (existingDoc.size || existingDoc.item_size || existingDoc.itemSize)) {
            size = existingDoc.size || existingDoc.item_size || existingDoc.itemSize;
        } else if (Array.isArray(items) && items.length > 0) {
            const first = items[0];
            if (first && (first.size || first.s || first.sizeOption || first.item_size)) {
                size = first.size || first.s || first.sizeOption || first.item_size;
            } else {
                // try find any item with size
                const found = items.find((it) => it && (it.size || it.s || it.sizeOption || it.item_size));
                if (found) size = found.size || found.s || found.sizeOption || found.item_size;
            }
        }
        if (size !== null && size !== undefined) size = String(size);

        // Build payload (include commonly required attributes and both camelCase/snake_case)
        const now = new Date().toISOString();
        const canonicalOrderId = existingDoc?.orderId || existingDoc?.order_id || razorpay_order_id || `order_${Date.now()}`;

        const payload = {
            orderId: canonicalOrderId,
            order_id: canonicalOrderId,

            userId: userId || existingDoc?.userId || null,

            // amount as provided by client (rupees) and paise if available from paymentDetails
            amount: typeof amountFromClient !== "undefined" ? Number(amountFromClient) : existingDoc?.amount || null,
            amountPaise: paymentDetails?.amount || existingDoc?.amountPaise || null,

            currency: currency || existingDoc?.currency || (paymentDetails?.currency || "INR"),

            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,

            status: "paid",

            items: Array.isArray(items) && items.length ? items : existingDoc?.items || [],

            verification_raw: JSON.stringify({ paymentDetails }),

            // shipping (must be present if collection requires it)
            shipping: shippingArray,

            // flattened shipping fields (snake_case)
            shipping_full_name,
            shipping_phone,
            shipping_line_1,
            shipping_line_2,
            shipping_city,
            shipping_state,
            shipping_postal_code,
            shipping_country,

            // size fields (some collections require size)
            size: size || existingDoc?.size || null,
            item_size: size || existingDoc?.item_size || null,

            paidAt: now,
            // updatedAt: now,
            // createdAt: existingDoc?.createdAt || now,
        };

        // Create or update document
        let saved = null;
        if (existingDoc) {
            // Update (only send fields you want to set)
            try {
                saved = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, existingDoc.$id, payload);
                log("Updated existing order doc:", existingDoc.$id);
            } catch (updErr) {
                error("Failed updating order doc:", updErr.message || updErr);
                // return helpful error so client/dev can inspect
                return res.json({ success: false, message: "Failed updating order doc", error: String(updErr) }, 500);
            }
        } else {
            // Create
            try {
                saved = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, ID.unique(), payload);
                log("Created new order doc:", saved.$id || saved.id || "(no id returned)");
            } catch (createErr) {
                error("Failed creating order doc:", createErr.message || createErr);
                return res.json({ success: false, message: "Failed creating order doc", error: String(createErr) }, 500);
            }
        }

        return res.json({ success: true, message: "Payment verified and order saved", db: saved });
    } catch (err) {
        error("verifyPayment error: " + (err.message || err));
        return res.json({ success: false, message: "Unexpected error", error: String(err) }, 500);
    }
};
