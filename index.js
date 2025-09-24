// verifyPayment.js - patched: robust amount handling (accepts amountPaise or rupees)
import Razorpay from "razorpay";
import { Client, Databases, Query, ID } from "node-appwrite";
import crypto from "crypto";

const safeParse = (raw) => {
    try {
        if (!raw) return {};
        if (typeof raw === "string") return JSON.parse(raw);
        if (typeof raw === "object") return raw;
    } catch {
        try { return JSON.parse(String(raw || "{}")); } catch { return {}; }
    }
    return {};
};

const makeRazorpayClient = () => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
        throw new Error("Missing Razorpay credentials in environment (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
    }
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

// Build a compact items summary string (<= 999 chars) and full JSON
const buildItemsSummary = (itemsInput) => {
    const itemsArr = Array.isArray(itemsInput) ? itemsInput : itemsInput ? [itemsInput] : [];
    let summary = "";
    try {
        const mapped = itemsArr.map((it) => {
            if (!it || typeof it !== "object") return String(it);
            return {
                productId: it.productId ?? it.id ?? null,
                name: it.name ?? it.productName ?? it.title ?? null,
                qty: it.quantity ?? it.qty ?? 1,
                size: it.size ?? null,
                price: it.price ?? null,
            };
        });
        summary = JSON.stringify(mapped);
    } catch {
        try { summary = JSON.stringify(itemsArr); } catch { summary = "[]"; }
    }
    if (summary.length > 999) summary = summary.slice(0, 999);
    const items_json = (() => {
        try { return JSON.stringify(itemsArr); } catch { return "[]"; }
    })();
    return { items_summary_string: summary || JSON.stringify([{ name: "unknown", qty: 1 }]), items_json };
};

export default async ({ req, res, log, error }) => {
    log("verifyPayment invoked");
    try {
        if (req.method !== "POST") return res.json({ success: false, message: "Method not allowed" }, 405);

        const raw =
            req.bodyRaw ||
            req.payload ||
            req.variables?.APPWRITE_FUNCTION_DATA ||
            req.headers?.["x-appwrite-function-data"] ||
            req.body ||
            "{}";
        const bodyData = safeParse(raw);
        // support nested body/data strings
        if (typeof bodyData.body === "string") Object.assign(bodyData, safeParse(bodyData.body));
        if (typeof bodyData.data === "string") Object.assign(bodyData, safeParse(bodyData.data));

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            userId,
            items,
            amount,        // may be rupees OR paise depending on client
            amountPaise,   // optional explicit paise (preferred)
            currency = "INR",
        } = bodyData || {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ success: false, message: "Missing required payment fields" }, 400);
        }

        // Ensure secret exists before creating client & verifying
        if (!process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_KEY_ID) {
            error("Missing Razorpay env vars");
            return res.json({ success: false, message: "Server misconfiguration: missing Razorpay credentials" }, 500);
        }

        // Signature verification (HMAC SHA256)
        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
            log("Signature mismatch", { generatedSignaturePreview: generatedSignature.slice(0, 8) + "...", providedPreview: razorpay_signature.slice(0, 8) + "..." });
            return res.json({ success: false, message: "Invalid signature" }, 400);
        }

        // Create Razorpay client (now that env is confirmed)
        let razorpay;
        try {
            razorpay = makeRazorpayClient();
        } catch (e) {
            error("Razorpay client creation failed: " + e.message);
            return res.json({ success: false, message: "Server misconfiguration: cannot create Razorpay client" }, 500);
        }

        // Fetch payment details (best-effort)
        let paymentDetails = null;
        try {
            paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
            log("Fetched payment", paymentDetails?.id || "[no-id]");
        } catch (fetchErr) {
            log("Could not fetch payment details (continuing):", fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr));
            // continue — because signature verification is primary; but we still attempt to save.
        }

        // Robust amount check:
        // Priority:
        // 1) If client provided explicit amountPaise -> use it
        // 2) Else if client provided amount and it looks like paise (integer >= 100) -> treat as paise
        // 3) Else treat amount as rupees and convert to paise
        if (typeof amountPaise !== "undefined" || typeof amount !== "undefined") {
            let expectedPaise = null;

            if (typeof amountPaise !== "undefined") {
                // if client explicitly sends amountPaise, use it (trust but still numeric)
                const ap = Number(amountPaise);
                if (!Number.isFinite(ap) || ap <= 0) {
                    log("Invalid amountPaise provided", { amountPaise });
                    return res.json({ success: false, message: "Invalid amountPaise provided" }, 400);
                }
                expectedPaise = Math.round(ap);
            } else {
                // amount provided but ambiguous: decide if it's paise or rupees
                const amtNum = Number(amount);
                if (!Number.isFinite(amtNum)) {
                    log("Invalid amount provided", { amount });
                    return res.json({ success: false, message: "Invalid amount provided" }, 400);
                }

                // Heuristic:
                // - If amount is an integer and >= 100 -> likely paise (e.g. 149900)
                // - Else treat as rupees and multiply by 100
                if (Number.isInteger(amtNum) && Math.abs(amtNum) >= 100) {
                    expectedPaise = Math.round(amtNum);
                } else {
                    expectedPaise = Math.round(amtNum * 100);
                }
            }

            if (paymentDetails?.amount !== undefined && expectedPaise !== null) {
                if (Number(paymentDetails.amount) !== expectedPaise) {
                    log("Amount mismatch", { expectedPaise, actual: paymentDetails.amount });
                    return res.json({ success: false, message: "Payment amount mismatch" }, 400);
                }
            } else {
                // couldn't compare (missing payment details), continue
                log("Amount check skipped (missing payment details or expectedPaise)", { expectedPaise, paymentDetailsPresent: !!paymentDetails });
            }
        }

        // Prepare items summary and JSON (string <=999 chars to satisfy Appwrite schemas expecting string)
        const { items_summary_string, items_json } = buildItemsSummary(items);
        const sizeValue = Array.isArray(items) && items[0] && items[0].size ? String(items[0].size) : null;

        // Build payload to store/update in DB
        const verificationPayload = {
            userId: userId || null,
            // prefer explicit amountPaise if provided, else use paymentDetails amount
            amount: typeof amount !== "undefined" ? Number(amount) : null,
            amountPaise: (typeof amountPaise !== "undefined" ? Number(amountPaise) : (paymentDetails?.amount ?? null)),
            currency,
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            status: "paid",
            items: items_summary_string,    // schema-friendly string (<=999)
            items_json,                     // full JSON if you want to keep it
            size: sizeValue,
            verification_raw: (() => {
                // Keep a concise verification blob (truncate paymentDetails to avoid huge payloads)
                try {
                    const dump = { paymentDetails };
                    let text = JSON.stringify(dump);
                    if (text.length > 2000) text = text.slice(0, 2000); // truncate if needed
                    return text;
                } catch {
                    return "{}";
                }
            })(),
            // createdAt: new Date().toISOString(), // let Appwrite use $createdAt
        };

        // Appwrite client & collection config from env (safer)
        const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
        const APPWRITE_PROJECT = process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT || "684c05fe002863accd73";
        const APPWRITE_DB = process.env.APPWRITE_DATABASE_ID || "68c414290032f31187eb";
        const APPWRITE_COLLECTION = process.env.APPWRITE_ORDERS_COLLECTION_ID || process.env.APPWRITE_ORDERS_COLLECTION || "68c58bfe0001e9581bd4";

        const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT);
        if (req.headers?.["x-appwrite-key"]) client.setKey(req.headers["x-appwrite-key"]);
        else if (process.env.APPWRITE_API_KEY) client.setKey(process.env.APPWRITE_API_KEY); // allow env key

        const databases = new Databases(client);

        // Look for existing order doc with this razorpay_order_id
        let saved = null;
        try {
            const listRes = await databases.listDocuments(
                APPWRITE_DB,
                APPWRITE_COLLECTION,
                [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
            );

            const doc = listRes.documents?.[0];
            if (doc) {
                // Update existing document
                await databases.updateDocument(APPWRITE_DB, APPWRITE_COLLECTION, doc.$id, verificationPayload);
                saved = { id: doc.$id, updated: true };
            } else {
                // Create new document
                const newDoc = await databases.createDocument(APPWRITE_DB, APPWRITE_COLLECTION, ID.unique(), verificationPayload);
                saved = { id: newDoc.$id || null, created: true };
            }
        } catch (dbErr) {
            error("Appwrite DB error (verifyPayment): " + (dbErr && dbErr.message ? dbErr.message : String(dbErr)));
            // Return success=false but include minimal diagnostic (no secrets)
            return res.json({
                success: false,
                message: "Payment verified but DB save failed. See function logs for details.",
                dbError: dbErr && dbErr.message ? dbErr.message : String(dbErr),
            }, 500);
        }

        return res.json({ success: true, message: "Payment verified and order saved", db: saved });
    } catch (err) {
        error("verifyPayment error: " + (err.message || err));
        return res.json({ success: false, message: "Unexpected error", error: String(err) }, 500);
    }
};
