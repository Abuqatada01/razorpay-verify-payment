// verifyPayment.js (Appwrite Function) - Create DB record AFTER successful payment
import Razorpay from "razorpay";
import { Client, Databases, Query, ID } from "node-appwrite";
import crypto from "crypto";

const client = new Client()
  .setEndpoint("https://fra.cloud.appwrite.io/v1")
  .setProject("684c05fe002863accd73")
  .setKey(process.env.APPWRITE_API_KEY); // safer than headers

const databases = new Databases(client);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export default async ({ req, res, log, error }) => {
  try {
    if (req.method !== "POST") {
      return res.json({ success: false, message: "Method not allowed" }, 405);
    }

    const bodyData = (() => {
      try {
        return JSON.parse(req.bodyRaw || "{}");
      } catch {
        return {};
      }
    })();

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
      items,
      amount,
      currency = "INR",
    } = bodyData;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.json(
        { success: false, message: "Missing required payment fields" },
        400
      );
    }

    // Verify signature
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.json({ success: false, message: "Invalid signature" }, 400);
    }

    // Fetch payment details from Razorpay
    const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);

    // Save order in DB only now (after successful payment)
    const dbDoc = await databases.createDocument(
      "68c414290032f31187eb", // Database ID
      "68c58bfe0001e9581bd4", // Collection ID
      ID.unique(),
      {
        userId,
        amount: Number(amount),
        amountPaise: paymentDetails.amount,
        currency,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        status: "paid",
        items,
        size: Array.isArray(items) && items[0]?.size ? items[0].size : null,
        verification_raw: JSON.stringify(paymentDetails),
        createdAt: new Date().toISOString(),
      }
    );

    return res.json({
      success: true,
      message: "Payment verified & order saved",
      dbDoc,
    });
  } catch (err) {
    error("Unexpected error: " + err.message);
    return res.json({ success: false, error: err.message }, 500);
  }
};
