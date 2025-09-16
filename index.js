import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Razorpay Function execution started");

        // ✅ Appwrite client
        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1")
            .setProject("684c05fe002863accd73")
            .setKey(req.headers['x-appwrite-key']);

        const databases = new Databases(client);

        // ✅ Razorpay client
        const razorpay = new Razorpay({
            key_id: "rzp_test_RH8HdkZbA9xnoK",
            key_secret: "V2OIX2UM8B6CGlxk0UjzQmk1",
        });

        if (req.method === "POST") {
            log("📩 POST request received for Razorpay order");

            // Parse request
            let bodyData = {};
            try {
                bodyData = JSON.parse(req.bodyRaw || "{}");
            } catch {
                return res.json({ success: false, message: "Invalid JSON" }, 400);
            }

            const { productId, amount } = bodyData;
            if (!productId || !amount) {
                return res.json(
                    { success: false, message: "productId and amount required" },
                    400
                );
            }
            // Ensure amount is integer
            const intAmount = parseInt(amount, 10);
            if (isNaN(intAmount)) {
                return res.json({ success: false, message: "Amount must be a number" }, 400);
            }
            // ✅ Create Razorpay order
            const order = await razorpay.orders.create({
                amount: intAmount * 100, // paise
                currency: "INR",
                receipt: `receipt_${Date.now()}`,
            });

            log("✅ Razorpay order created");

            // ✅ Save minimal order in Appwrite DB
            const savedOrder = await databases.createDocument(
                "68c414290032f31187eb",
                "68c8567e001a18aefff0",
                ID.unique(),
                {
                    productId,
                    amount: intAmount, // ✅ saved as integer
                    orderId: order.id,
                    paymentId: null,
                    status: "unpaid",
                }
            );

            log("✅ Order saved in Appwrite DB");

            return res.json({
                success: true,
                order,
                dbRecord: savedOrder,
            });
        }

        if (req.method === "GET") {
            return res.text("🚀 Razorpay Appwrite Function is live");
        }

        return res.json(
            { success: false, message: `Method ${req.method} not allowed` },
            405
        );
    } catch (err) {
        error("Unexpected error: " + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
