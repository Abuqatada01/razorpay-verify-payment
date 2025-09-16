import Razorpay from "razorpay";

export default async ({ req, res, log, error }) => {
    try {
        log("Razorpay Function execution started ✅");

        // ✅ Initialize Razorpay instance
        const razorpay = new Razorpay({
            key_id: "rzp_test_RH8HdkZbA9xnoK",       // Add in Appwrite Function Variables
            key_secret: "V2OIX2UM8B6CGlxk0UjzQmk1",
        });

        if (req.method === "POST") {
            log("POST request received for Razorpay order");

            // Parse body to extract amount & currency
            let bodyData = {};
            try {
                bodyData = JSON.parse(req.bodyRaw || "{}");
            } catch (parseError) {
                error("Invalid JSON body");
                return res.json({ success: false, message: "Invalid JSON" }, 400);
            }

            const { amount, currency = "INR", receipt = "receipt_1" } = bodyData;

            if (!amount) {
                return res.json({ success: false, message: "Amount is required" }, 400);
            }

            // ✅ Create Razorpay order
            const options = {
                amount: amount * 100, // convert to paise
                currency,
                receipt,
            };

            const order = await razorpay.orders.create(options);

            log("Razorpay order created successfully");
            return res.json({
                success: true,
                order,
            });
        }

        if (req.method === "GET") {
            return res.text("Razorpay Appwrite Function is live 🚀");
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
