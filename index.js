// verifyPayment.js (Appwrite Function) - improved & idempotent
import Razorpay from "razorpay";
import { Client, Databases, Query } from "node-appwrite";
import crypto from "crypto";

const safeParse = (raw) => {
    try {
        if (!raw) return {};
        if (typeof raw === "string") return JSON.parse(raw);
        if (typeof raw === "object") return raw;
    } catch {
        try {
            const first = JSON.parse(String(raw || "{}"));
            return typeof first === "object" ? first : {};
        } catch {
            return {};
        }
    }
    return {};
};

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ VerifyPayment Function started");

        if (req.method !== "POST") {
            return res.json({ success: false, message: "Method not allowed" }, 405);
        }

        // Appwrite client
        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1")
            .setProject("684c05fe002863accd73");

        // prefer header key, fallback to environment key if available
        const appwriteKey = req.headers?.["x-appwrite-key"] || process.env.APPWRITE_KEY;
        if (appwriteKey) client.setKey(appwriteKey);

        const databases = new Databases(client);

        // Parse incoming payload robustly (Appwrite may provide bodyRaw, payload or header)
        const raw =
            req.bodyRaw ||
            req.payload ||
            req.variables?.APPWRITE_FUNCTION_DATA ||
            req.headers?.["x-appwrite-function-data"] ||
            "{}";

        const bodyData = safeParse(raw);
        if (typeof bodyData.body === "string") Object.assign(bodyData, safeParse(bodyData.body));
        if (typeof bodyData.data === "string") Object.assign(bodyData, safeParse(bodyData.data));

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            expectedAmount, // optional: rupees
        } = bodyData || {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ success: false, message: "Missing required payment fields" }, 400);
        }

        log("Verifying signature for order:", razorpay_order_id);

        // Validate signature (HMAC SHA256 of order_id|payment_id)
        const secret = process.env.RAZORPAY_KEY_SECRET;
        if (!secret) {
            error("Razorpay secret not set in env");
            return res.json({ success: false, message: "Server misconfiguration" }, 500);
        }

        const generatedSignature = crypto
            .createHmac("sha256", secret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
            log("Signature mismatch for order:", razorpay_order_id);
            // best-effort persist mismatch
            try {
                const listRes = await databases.listDocuments(
                    "68c414290032f31187eb",
                    "68c58bfe0001e9581bd4",
                    [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
                );

                const doc = listRes.documents?.[0];
                if (doc) {
                    await databases.updateDocument(
                        "68c414290032f31187eb",
                        "68c58bfe0001e9581bd4",
                        doc.$id,
                        {
                            razorpay_payment_id,
                            razorpay_signature,
                            status: "payment_failed_signature",
                            verification_raw: JSON.stringify({
                                reason: "signature_mismatch",
                                generatedSignature,
                                receivedSignature: razorpay_signature,
                                at: new Date().toISOString(),
                            }),
                        }
                    );
                }
            } catch (e) {
                error("Failed to persist signature-mismatch info: " + (e.message || e));
            }

            return res.json({ success: false, message: "Invalid signature" }, 400);
        }

        log("Signature verification passed for:", razorpay_order_id);

        // Create Razorpay client and fetch payment (optional but recommended)
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: secret,
        });

        let paymentDetails = null;
        try {
            paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
            log("Fetched payment details:", paymentDetails?.id);
        } catch (e) {
            log("Could not fetch payment details from Razorpay:", e.message || e);
            // continue — signature is primary check; but we prefer to have paymentDetails
        }

        // If expectedAmount present, cross-check amounts (expected in rupees)
        if (expectedAmount && paymentDetails?.amount !== undefined) {
            const expectedPaise = Math.round(Number(expectedAmount) * 100);
            if (Number(paymentDetails.amount) !== expectedPaise) {
                log("Amount mismatch", { expectedPaise, actualPaise: paymentDetails.amount });
                // persist and return error
                try {
                    const listRes = await databases.listDocuments(
                        "68c414290032f31187eb",
                        "68c58bfe0001e9581bd4",
                        [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
                    );
                    const doc = listRes.documents?.[0];
                    if (doc) {
                        await databases.updateDocument(
                            "68c414290032f31187eb",
                            "68c58bfe0001e9581bd4",
                            doc.$id,
                            {
                                razorpay_payment_id,
                                razorpay_signature,
                                status: "payment_failed_amount_mismatch",
                                verification_raw: JSON.stringify({
                                    reason: "amount_mismatch",
                                    expectedPaise,
                                    actualPaise: paymentDetails.amount,
                                    at: new Date().toISOString(),
                                }),
                            }
                        );
                    }
                } catch (e) {
                    error("Failed to persist amount-mismatch info: " + (e.message || e));
                }
                return res.json({ success: false, message: "Payment amount mismatch" }, 400);
            }
        }

        // Ensure payment status is acceptable (captured). Adjust if you accept other statuses.
        if (paymentDetails && paymentDetails.status !== "captured") {
            // You might accept 'authorized' if you capture later — change as needed.
            log("Payment not captured yet:", paymentDetails.status);
            // Persist as pending capture
            try {
                const listRes = await databases.listDocuments(
                    "68c414290032f31187eb",
                    "68c58bfe0001e9581bd4",
                    [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
                );
                const doc = listRes.documents?.[0];
                if (doc) {
                    await databases.updateDocument(
                        "68c414290032f31187eb",
                        "68c58bfe0001e9581bd4",
                        doc.$id,
                        {
                            razorpay_payment_id,
                            razorpay_signature,
                            status: `payment_${paymentDetails.status}`,
                            verification_raw: JSON.stringify({
                                reason: "payment_not_captured",
                                paymentStatus: paymentDetails.status,
                                at: new Date().toISOString(),
                                paymentDetails,
                            }),
                        }
                    );
                }
            } catch (e) {
                error("Failed to persist non-captured payment state: " + (e.message || e));
            }
            // Return success if you want to treat this as accepted, or return error.
            return res.json({ success: false, message: `Payment not captured: ${paymentDetails.status}` }, 400);
        }

        // Find the Appwrite order and update idempotently
        try {
            const listRes = await databases.listDocuments(
                "68c414290032f31187eb",
                "68c58bfe0001e9581bd4",
                [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
            );

            const doc = listRes.documents?.[0];
            if (!doc) {
                log("Order not found for razorpay_order_id:", razorpay_order_id);
                return res.json({ success: false, message: "Order not found" }, 404);
            }

            // Idempotency: if already marked paid, return success
            if (doc.status === "paid" || doc.status === "payment_completed") {
                log("Order already marked paid:", doc.$id);
                return res.json({ success: true, message: "Already verified" });
            }

            const updatePayload = {
                razorpay_payment_id,
                razorpay_signature,
                status: "paid",
                verification_raw: JSON.stringify({
                    verifiedAt: new Date().toISOString(),
                    paymentDetails: paymentDetails || null,
                }),
            };

            if (paymentDetails) {
                updatePayload["amountPaisePaid"] = paymentDetails.amount;
                updatePayload["payment_method"] = paymentDetails.method;
                updatePayload["payment_status"] = paymentDetails.status;
            }

            await databases.updateDocument(
                "68c414290032f31187eb",
                "68c58bfe0001e9581bd4",
                doc.$id,
                updatePayload
            );

            log("Order updated to paid:", doc.$id);
            return res.json({ success: true, message: "Payment verified and order updated" });
        } catch (e) {
            error("Failed to update order document: " + (e.message || e));
            return res.json({ success: false, message: "Failed to update order: " + (e.message || e) }, 500);
        }
    } catch (err) {
        error("Unexpected error: " + (err.message || err));
        return res.json({ success: false, error: (err.message || String(err)) }, 500);
    }
};
