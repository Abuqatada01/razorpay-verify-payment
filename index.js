// verifyPayment.js - safe instantiation + helpful errors
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
    const keyId = "rzp_test_RH8HdkZbA9xnoK";
    const keySecret = "V2OIX2UM8B6CGlxk0UjzQmk1";
    if (!keyId || !keySecret) {
        throw new Error("Missing Razorpay credentials: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in function env");
    }
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
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
            "{}";
        const bodyData = safeParse(raw);
        if (typeof bodyData.body === "string") Object.assign(bodyData, safeParse(bodyData.body));
        if (typeof bodyData.data === "string") Object.assign(bodyData, safeParse(bodyData.data));

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, items, amount, currency = "INR" } = bodyData || {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ success: false, message: "Missing required payment fields" }, 400);
        }

        // Ensure secret exists before creating client
        if (!process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_KEY_ID) {
            error("Missing Razorpay env vars");
            return res.json({ success: false, message: "Server misconfiguration: missing Razorpay credentials" }, 500);
        }

        // Signature verification
        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
            log("Signature mismatch", { generatedSignature, razorpay_signature });
            return res.json({ success: false, message: "Invalid signature" }, 400);
        }

        // Create Razorpay client now that env is confirmed
        const razorpay = makeRazorpayClient();

        // Fetch payment details
        let paymentDetails = null;
        try {
            paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
            log("Fetched payment", paymentDetails?.id);
        } catch (fetchErr) {
            log("Could not fetch payment details", fetchErr.message || fetchErr);
            // continue — signature is main check, but you may choose to fail here
        }

        // Optional amount check
        if (typeof amount !== "undefined" && paymentDetails?.amount !== undefined) {
            const expectedPaise = Math.round(Number(amount) * 100);
            if (Number(paymentDetails.amount) !== expectedPaise) {
                log("Amount mismatch", { expectedPaise, actual: paymentDetails.amount });
                return res.json({ success: false, message: "Payment amount mismatch" }, 400);
            }
        }

        // Create or update DB record AFTER verification
        const client = new Client().setEndpoint("https://fra.cloud.appwrite.io/v1").setProject("684c05fe002863accd73");
        if (req.headers?.["x-appwrite-key"]) client.setKey(req.headers["x-appwrite-key"]);
        const databases = new Databases(client);

        // If an order doc exists for this razorpay_order_id, update it; else create new
        const listRes = await databases.listDocuments(
            "68c414290032f31187eb",
            "68c58bfe0001e9581bd4",
            [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
        );

        const doc = listRes.documents?.[0];
        const payload = {
            userId: userId || null,
            amount: typeof amount !== "undefined" ? Number(amount) : null,
            amountPaise: paymentDetails?.amount || null,
            currency,
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            status: "paid",
            items: Array.isArray(items) ? items.map(it => (it && typeof it === "object" ? `${it.name || it.title || it.productId}${it.size ? ` (Size: ${it.size})` : ""}` : String(it))) : [],
            size: Array.isArray(items) && items[0]?.size ? String(items[0].size) : null,
            verification_raw: JSON.stringify({ paymentDetails }),
            createdAt: new Date().toISOString(),
        };

        let saved = null;
        if (doc) {
            await databases.updateDocument("68c414290032f31187eb", "68c58bfe0001e9581bd4", doc.$id, payload);
            saved = { id: doc.$id, updated: true };
        } else {
            const newDoc = await databases.createDocument("68c414290032f31187eb", "68c58bfe0001e9581bd4", ID.unique(), payload);
            saved = newDoc;
        }

        return res.json({ success: true, message: "Payment verified and order saved", db: saved });
    } catch (err) {
        error("verifyPayment error: " + (err.message || err));
        return res.json({ success: false, message: "Unexpected error", error: String(err) }, 500);
    }
};
