// verifyPayment.js (Appwrite Function)
import Razorpay from "razorpay";
import { Client, Databases, Query } from "node-appwrite";
import crypto from "crypto";

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ VerifyPayment Function started");

        // Appwrite client
        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1")
            .setProject("684c05fe002863accd73")
            .setKey(req.headers["x-appwrite-key"]);

        const databases = new Databases(client);

        // Razorpay client
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        if (req.method !== "POST") {
            return res.json({ success: false, message: "Method not allowed" }, 405);
        }

        // parse body safely
        let bodyData = {};
        try {
            bodyData = JSON.parse(req.bodyRaw || "{}");
        } catch (e) {
            log("Invalid JSON in request body");
            return res.json({ success: false, message: "Invalid JSON" }, 400);
        }

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            expectedAmount, // optional: amount in rupees for extra check
        } = bodyData;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json(
                { success: false, message: "Missing required payment fields" },
                400
            );
        }

        log("Verifying signature for order:", razorpay_order_id);

        // Verify signature using HMAC SHA256 of order_id|payment_id
        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
            log("Signature mismatch", { generatedSignature, razorpay_signature });
            // store attempt with failed status (best-effort; don't block)
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
                            razorpay_payment_id: razorpay_payment_id,
                            razorpay_signature: razorpay_signature,
                            status: "payment_failed_signature",
                            verification_raw: JSON.stringify({
                                reason: "signature_mismatch",
                                generatedSignature,
                                receivedSignature: razorpay_signature,
                            }),
                        }
                    );
                }
            } catch (e) {
                error("Failed to persist signature-mismatch info: " + e.message);
            }

            return res.json({ success: false, message: "Invalid signature" }, 400);
        }

        log("Signature verification passed.");

        // Optional: fetch payment details from Razorpay to confirm amount/currency
        let paymentDetails = null;
        try {
            paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
            log("Fetched payment from Razorpay:", paymentDetails.id);
        } catch (e) {
            log("Warning: could not fetch payment details from Razorpay:", e.message);
            // proceed — signature is primary validation for webhook-like flows
        }

        // If expectedAmount (rupees) provided, cross-check with payment amount (paise)
        if (expectedAmount && paymentDetails?.amount !== undefined) {
            const expectedPaise = Math.round(Number(expectedAmount) * 100);
            if (Number(paymentDetails.amount) !== expectedPaise) {
                log("Amount mismatch", {
                    expectedPaise,
                    actualPaise: paymentDetails.amount,
                });
                // persist mismatch and return error
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
                                razorpay_payment_id: razorpay_payment_id,
                                razorpay_signature: razorpay_signature,
                                status: "payment_failed_amount_mismatch",
                                verification_raw: JSON.stringify({
                                    reason: "amount_mismatch",
                                    expectedPaise,
                                    actualPaise: paymentDetails.amount,
                                }),
                            }
                        );
                    }
                } catch (e) {
                    error("Failed to persist amount-mismatch info: " + e.message);
                }

                return res.json(
                    { success: false, message: "Payment amount mismatch" },
                    400
                );
            }
        }

        // Find the Appwrite order document and update it to paid
        try {
            const listRes = await databases.listDocuments(
                "68c414290032f31187eb", // Database ID
                "68c58bfe0001e9581bd4", // Orders collection ID
                [Query.equal("razorpay_order_id", razorpay_order_id), Query.limit(1)]
            );

            const doc = listRes.documents?.[0];
            if (!doc) {
                log("Order not found for razorpay_order_id:", razorpay_order_id);
                return res.json({ success: false, message: "Order not found" }, 404);
            }

            const updatePayload = {
                razorpay_payment_id: razorpay_payment_id,
                razorpay_signature: razorpay_signature,
                status: "paid",
                verification_raw: JSON.stringify({
                    verifiedAt: new Date().toISOString(),
                    paymentDetails: paymentDetails || null,
                }),
            };

            // Optionally store the paid amount fields if paymentDetails exist
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
            error("Failed to update order document: " + e.message);
            return res.json(
                { success: false, message: "Failed to update order: " + e.message },
                500
            );
        }
    } catch (err) {
        error("Unexpected error: " + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
